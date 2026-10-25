import { fromRaw, toRaw, type ChainName } from "../shared";
import { prisma } from "../db";
import { releaseReserve, swapWusdtForUsdt, transferToken, type BroadcastResult } from "../chains/broadcaster";
import { vaultStateFor } from "../treasury/vault";
import { awaitReceipt } from "../chains/handshake";
import { onChainBalance } from "../chains/wallets";

/**
 * Autonomous Orchestrator Engine Layer.
 *
 * Three chained operations, each a separate audited step so a failure isolates:
 *   1. unlockTransfer    — move wUSDT out of a treasury/app wallet to an external wallet
 *   2. swapToUsdt        — swap wUSDT → official USDT through the chain's DEX
 *   3. liquidateForward  — liquidate wUSDT on the DEX, then forward the USDT out
 *
 * Every step surfaces a REAL transaction: the hash in the response comes back
 * from the node that accepted the broadcast, never from the caller.
 */

async function deploymentFor(chain: ChainName) {
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (!deployment) throw new Error(`chain ${chain} is not configured`);
  return deployment;
}

async function walletRow(walletId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  return wallet;
}

export interface UnlockTransferInput {
  adminId: string | null;
  chain: ChainName;
  walletId: string;
  toExternal: string;
  amountHuman: string;
}

export async function unlockTransfer(input: UnlockTransferInput): Promise<BroadcastResult> {
  const deployment = await deploymentFor(input.chain);
  const wallet = await walletRow(input.walletId);
  if (wallet.chain !== input.chain) throw new Error("wallet does not belong to the selected chain");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.toExternal)) throw new Error("external address is not a valid EVM address");

  const amountRaw = toRaw(input.amountHuman, deployment.wusdtDecimals);

  // The un-distributed reserve lives in the TreasuryVault, so a payout sourced
  // from the treasury wallet is a vault release rather than a wallet transfer.
  if (deployment.vault && wallet.kind === "treasury") {
    const vault = await vaultStateFor(input.chain, deployment);
    if (BigInt(vault.reserveRaw) < BigInt(amountRaw)) {
      throw new Error(
        `insufficient reserve: the TreasuryVault holds ${vault.reserveHuman} wUSDT, requested ${input.amountHuman}`,
      );
    }
    return releaseReserve(input.chain, input.toExternal, amountRaw, {
      adminId: input.adminId,
      note: "orchestrator: release reserve & transfer",
    });
  }

  const held = await onChainBalance(input.chain, deployment.wusdt, wallet.address);
  if (held < BigInt(amountRaw)) {
    throw new Error(
      `insufficient wUSDT: ${wallet.label} holds ${fromRaw(held, deployment.wusdtDecimals)}, requested ${input.amountHuman}`,
    );
  }

  return transferToken(input.chain, "wusdt", input.walletId, input.toExternal, amountRaw, {
    adminId: input.adminId,
    note: "orchestrator: unlock & transfer",
  });
}

/**
 * Swaps and liquidations are signed by a wallet, so reserve-sourced wUSDT has to
 * be released from the vault into that wallet first. A release of the same
 * amount the wallet is short also covers a partial top-up, and an app wallet
 * (which already holds its own 25 % share) needs nothing.
 */
async function fundFromReserve(
  deployment: { vault: string; wusdt: string; wusdtDecimals: number },
  chain: ChainName,
  wallet: { kind: string; address: string },
  amountRaw: string,
  adminId: string | null,
): Promise<BroadcastResult | null> {
  if (!deployment.vault || wallet.kind !== "treasury") return null;

  const held = await onChainBalance(chain, deployment.wusdt, wallet.address);
  const missing = BigInt(amountRaw) - held;
  if (missing <= 0n) return null;

  return releaseReserve(chain, wallet.address, missing.toString(), {
    adminId,
    note: `orchestrator: release ${fromRaw(missing, deployment.wusdtDecimals)} from the reserve`,
  });
}

export interface SwapInput {
  adminId: string | null;
  chain: ChainName;
  walletId: string;
  amountHuman: string;
  minOutHuman: string;
}

export async function swapToUsdt(input: SwapInput) {
  const deployment = await deploymentFor(input.chain);
  const wallet = await walletRow(input.walletId);
  if (wallet.chain !== input.chain) throw new Error("wallet does not belong to the selected chain");

  const amountInRaw = toRaw(input.amountHuman, deployment.wusdtDecimals);
  const minOutRaw = toRaw(input.minOutHuman, deployment.usdtDecimals);

  await fundFromReserve(deployment, input.chain, wallet, amountInRaw, input.adminId);

  const held = await onChainBalance(input.chain, deployment.wusdt, wallet.address);
  if (held < BigInt(amountInRaw)) {
    throw new Error(
      `insufficient wUSDT: ${wallet.label} holds ${fromRaw(held, deployment.wusdtDecimals)}, requested ${input.amountHuman}`,
    );
  }

  return swapWusdtForUsdt(input.chain, input.walletId, amountInRaw, minOutRaw, { adminId: input.adminId });
}

export interface LiquidateForwardInput {
  adminId: string | null;
  chain: ChainName;
  walletId: string;
  toExternal: string;
  amountHuman: string;
  slippageBps: number;
}

/**
 * Step A liquidates wUSDT into real USDT on the DEX, then step B forwards
 * exactly the USDT the swap actually produced — measured from the on-chain
 * balance delta after the receipt lands, not from a quote.
 */
export async function liquidateForward(input: LiquidateForwardInput) {
  const deployment = await deploymentFor(input.chain);
  const wallet = await walletRow(input.walletId);
  if (wallet.chain !== input.chain) throw new Error("wallet does not belong to the selected chain");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.toExternal)) throw new Error("external address is not a valid EVM address");

  const amountInRaw = toRaw(input.amountHuman, deployment.wusdtDecimals);

  await fundFromReserve(deployment, input.chain, wallet, amountInRaw, input.adminId);

  const held = await onChainBalance(input.chain, deployment.wusdt, wallet.address);
  if (held < BigInt(amountInRaw)) {
    throw new Error(
      `insufficient wUSDT: ${wallet.label} holds ${fromRaw(held, deployment.wusdtDecimals)}, requested ${input.amountHuman}`,
    );
  }

  const slippageBps = Math.min(Math.max(input.slippageBps, 0), 5_000);
  // Peg-parity floor: wUSDT ≡ USDT, so the worst acceptable out is the input
  // reduced by the slippage budget (and the DEX fee applies on top).
  const minOutRaw = toRaw(
    (Number(input.amountHuman) * (10_000 - slippageBps)) / 10_000,
    deployment.usdtDecimals,
  );

  const before = await onChainBalance(input.chain, deployment.usdt, wallet.address);

  const swap = await swapWusdtForUsdt(input.chain, input.walletId, amountInRaw, minOutRaw, {
    adminId: input.adminId,
  });
  await awaitReceipt(input.chain, swap.hash);

  const after = await onChainBalance(input.chain, deployment.usdt, wallet.address);
  const proceedsRaw = after - before;
  if (proceedsRaw <= 0n) throw new Error("liquidation produced no USDT — nothing to forward");

  const forward = await transferToken(input.chain, "usdt", input.walletId, input.toExternal, proceedsRaw.toString(), {
    adminId: input.adminId,
    direction: "liquidate_forward",
    note: `liquidate & forward after swap ${swap.hash}`,
  });

  return { swap, forward, proceedsRaw: proceedsRaw.toString(), proceedsHuman: fromRaw(proceedsRaw, deployment.usdtDecimals) };
}

export async function onChainBalanceOf(chain: ChainName, token: "wusdt" | "usdt", walletId: string) {
  const deployment = await deploymentFor(chain);
  const wallet = await walletRow(walletId);
  const address = token === "wusdt" ? deployment.wusdt : deployment.usdt;
  const balance = await onChainBalance(chain, address, wallet.address);
  return balance.toString();
}
