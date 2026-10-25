import { transferToken } from "../chains/broadcaster";
import { onChainBalance } from "../chains/wallets";
import { prisma } from "../db";
import {
  GRACE_PERIOD_DAYS,
  LIQUIDATION_INCENTIVE_BPS,
  TERM_TIERS,
  fromRaw,
  isTermKey,
  quoteInterestRaw,
  requiredCollateralRaw,
  toRaw,
  type ChainName,
  type TermKey,
} from "../shared";

/**
 * Treasury Vault lending book.
 *
 * Fixed-term, fixed-rate: APR is locked at origination from the term ladder
 * (3.5 % / 6 % / 10 % / 15 % — see shared/lending.ts), interest is simple over
 * the fixed term, and the vault's lendable balance is its REAL on-chain USDT
 * balance, so a loan can never exceed custodied USDT (`VaultSupplyExhausted`).
 *
 * Disbursement and repayment are real broadcasts with real hashes. Collateral is
 * recorded in this book rather than escrowed on chain — the on-chain
 * TreasuryLendingEngine custody path is a listed gap in the README.
 */

async function deploymentFor(chain: ChainName) {
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (!deployment) throw new Error(`chain ${chain} is not configured`);
  return deployment;
}

export async function listCollateral(chain: ChainName) {
  return prisma.collateralAsset.findMany({ where: { chain, approved: true }, orderBy: { symbol: "asc" } });
}

export interface QuoteInput {
  chain: ChainName;
  principalHuman: string;
  term: string;
  collateralId: string;
}

/** Mirrors the contract quote: the dashboard shows exactly what origination will charge. */
export async function quoteLoan(input: QuoteInput) {
  if (!isTermKey(input.term)) throw new Error(`unknown term ${input.term}`);
  const deployment = await deploymentFor(input.chain);
  const asset = await prisma.collateralAsset.findUnique({ where: { id: input.collateralId } });
  if (!asset) throw new Error("collateral asset not found");

  const principalRaw = toRaw(input.principalHuman, deployment.usdtDecimals);
  const interestRaw = quoteInterestRaw(principalRaw, input.term);
  const totalRaw = (BigInt(principalRaw) + BigInt(interestRaw)).toString();
  const requiredRaw = requiredCollateralRaw({
    principalRaw,
    priceRaw8: asset.priceRaw8,
    haircutBps: asset.haircutBps,
    ltvBps: asset.ltvBps,
    collateralDecimals: asset.decimals,
  });

  const tier = TERM_TIERS[input.term];
  return {
    chain: input.chain,
    term: input.term,
    termLabel: tier.label,
    days: tier.days,
    aprBps: tier.aprBps,
    principalRaw,
    principalHuman: fromRaw(principalRaw, deployment.usdtDecimals),
    interestRaw,
    interestHuman: fromRaw(interestRaw, deployment.usdtDecimals),
    totalRepayRaw: totalRaw,
    totalRepayHuman: fromRaw(totalRaw, deployment.usdtDecimals),
    requiredCollateralRaw: requiredRaw,
    requiredCollateralHuman: fromRaw(requiredRaw, asset.decimals),
    effectiveAprPct: tier.aprBps / 100,
    collateral: asset,
    usdtDecimals: deployment.usdtDecimals,
  };
}

export interface OriginateInput {
  adminId: string | null;
  chain: ChainName;
  borrowerWalletId: string;
  principalHuman: string;
  term: string;
  collateralId: string;
  collateralHuman: string;
}

export async function originateLoan(input: OriginateInput) {
  if (!isTermKey(input.term)) throw new Error(`unknown term ${input.term}`);

  const deployment = await deploymentFor(input.chain);
  const treasury = await prisma.wallet.findFirst({ where: { chain: input.chain, kind: "treasury" } });
  if (!treasury) throw new Error("treasury wallet missing");

  const borrower = await prisma.wallet.findUnique({ where: { id: input.borrowerWalletId } });
  if (!borrower || borrower.chain !== input.chain) throw new Error("borrower wallet not found on this chain");

  const asset = await prisma.collateralAsset.findUnique({ where: { id: input.collateralId } });
  if (!asset || !asset.approved) throw new Error("collateral is not in the approved registry");

  const principalRaw = toRaw(input.principalHuman, deployment.usdtDecimals);
  if (BigInt(principalRaw) <= 0n) throw new Error("principal must be positive");

  // Vault supply gate — the lendable supply IS the vault's real USDT balance.
  const lendable = await onChainBalance(input.chain, deployment.usdt, treasury.address);
  if (BigInt(principalRaw) > lendable) {
    throw new Error(
      `VaultSupplyExhausted: vault holds ${fromRaw(lendable, deployment.usdtDecimals)} USDT, requested ${input.principalHuman}`,
    );
  }

  const requiredRaw = requiredCollateralRaw({
    principalRaw,
    priceRaw8: asset.priceRaw8,
    haircutBps: asset.haircutBps,
    ltvBps: asset.ltvBps,
    collateralDecimals: asset.decimals,
  });
  const providedRaw = toRaw(input.collateralHuman, asset.decimals);
  if (BigInt(providedRaw) < BigInt(requiredRaw)) {
    throw new Error(
      `OverLTV: requires ${fromRaw(requiredRaw, asset.decimals)} ${asset.symbol}, provided ${input.collateralHuman}`,
    );
  }

  const tier = TERM_TIERS[input.term];
  const interestRaw = quoteInterestRaw(principalRaw, input.term);
  const totalRepayRaw = (BigInt(principalRaw) + BigInt(interestRaw)).toString();
  const startAt = new Date();
  const maturityAt = new Date(startAt.getTime() + tier.days * 86_400_000);

  const loan = await prisma.loan.create({
    data: {
      chain: input.chain,
      borrowerAddress: borrower.address,
      borrowerWalletId: borrower.id,
      collateralToken: asset.address,
      collateralSymbol: asset.symbol,
      collateralDecimals: asset.decimals,
      collateralAmount: providedRaw,
      principalRaw,
      aprBps: tier.aprBps,
      term: input.term,
      interestDueRaw: interestRaw,
      totalRepayRaw,
      ltvBps: asset.ltvBps,
      startAt,
      maturityAt,
      disbursementTxId: null,
    },
  });

  const disbursement = await transferToken(
    input.chain,
    "usdt",
    treasury.id,
    borrower.address,
    principalRaw,
    { adminId: input.adminId, direction: "lending", note: `loan ${loan.id} disbursement` },
  );

  const updated = await prisma.loan.update({
    where: { id: loan.id },
    data: { disbursementTxId: disbursement.txId },
  });

  return { loan: updated, disbursement, quote: { interestRaw, totalRepayRaw, requiredRaw: requiredRaw } };
}

export async function repayLoan(input: { adminId: string | null; loanId: string; fromWalletId?: string | null }) {
  const loan = await prisma.loan.findUnique({ where: { id: input.loanId } });
  if (!loan) throw new Error("loan not found");
  if (loan.status === "repaid") throw new Error("loan is already repaid");

  const deployment = await deploymentFor(loan.chain as ChainName);
  const treasury = await prisma.wallet.findFirst({ where: { chain: loan.chain, kind: "treasury" } });
  if (!treasury) throw new Error("treasury wallet missing");

  const payerWalletId = input.fromWalletId ?? loan.borrowerWalletId;
  if (!payerWalletId) throw new Error("no wallet available to repay from");
  const payer = await prisma.wallet.findUnique({ where: { id: payerWalletId } });
  if (!payer) throw new Error("repayment wallet not found");

  // Early repayment keeps full-term interest — the treasury's income stays
  // predictable and short-term borrowers self-select.
  const repayment = await transferToken(loan.chain as ChainName, "usdt", payer.id, treasury.address, loan.totalRepayRaw, {
    adminId: input.adminId,
    direction: "lending",
    note: `loan ${loan.id} repayment (full-term interest)`,
  });

  const updated = await prisma.loan.update({
    where: { id: loan.id },
    data: { status: "repaid", repaidAt: new Date(), repaidRaw: loan.totalRepayRaw, repaymentTxId: repayment.txId },
  });

  return { loan: updated, repayment, interestEarnedRaw: loan.interestDueRaw };
}

/** Flag loans that are past maturity + grace so a keeper can liquidate them. */
export async function sweepLiquidatableLoans(): Promise<number> {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_DAYS * 86_400_000);
  const result = await prisma.loan.updateMany({
    where: { status: "active", maturityAt: { lt: cutoff } },
    data: { status: "liquidatable" },
  });
  return result.count;
}

export async function liquidateLoan(input: { adminId: string | null; loanId: string }) {
  const loan = await prisma.loan.findUnique({ where: { id: input.loanId } });
  if (!loan) throw new Error("loan not found");
  if (loan.status === "repaid") throw new Error("loan is already repaid");

  const penaltyRaw = (
    (BigInt(loan.principalRaw) * BigInt(LIQUIDATION_INCENTIVE_BPS)) / 10_000n
  ).toString();

  const updated = await prisma.loan.update({
    where: { id: loan.id },
    data: { status: "liquidated" },
  });

  await prisma.auditLog.create({
    data: {
      adminId: input.adminId,
      action: "lending.liquidate",
      detail: JSON.stringify({ loanId: loan.id, collateral: loan.collateralSymbol, incentiveRaw: penaltyRaw }),
    },
  });

  return { loan: updated, liquidationIncentiveRaw: penaltyRaw };
}

export async function listLoans(chain?: ChainName) {
  const loans = await prisma.loan.findMany({
    where: chain ? { chain } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const totals = {
    activePrincipalRaw: loans
      .filter((l) => l.status === "active" || l.status === "liquidatable")
      .reduce((acc, l) => acc + BigInt(l.principalRaw), 0n)
      .toString(),
    interestBookedRaw: loans.reduce((acc, l) => acc + BigInt(l.interestDueRaw), 0n).toString(),
  };

  return { loans, totals };
}

export function termLadder(): { term: TermKey; days: number; aprBps: number; label: string }[] {
  return (Object.keys(TERM_TIERS) as TermKey[]).map((term) => ({ term, ...TERM_TIERS[term] }));
}
