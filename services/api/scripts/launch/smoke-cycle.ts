/**
 * GATE 4 — smoke cycle. Real funds, deliberately small.
 *
 * Per chain, sequentially: the attested reserve is read from chain, a $10k mint
 * cycle runs through the platform's own engine (which also pushes 25 % out to
 * the app wallets as separate transactions), a transfer-out goes to an
 * ops-owned external address, a swap runs on the chain's real DEX, and the
 * liquidation forwards the USDT the swap actually produced.
 *
 * Every broadcast is then checked three ways — the hash the broadcaster
 * returned, the receipt re-read from an INDEPENDENT endpoint, and the platform
 * ledger row it flipped to `confirmed` — so a bug in the platform's own indexer
 * cannot green-light a false pass. Nothing here accepts a hash as input: the
 * hashes are the ones the broadcaster produced.
 *
 * Requires the complete live environment (Gates 0-2 passed) plus DATABASE_URL,
 * and broadcasts REAL transactions from the custody key:
 *   docker compose exec -T api npx tsx services/api/scripts/launch/smoke-cycle.ts
 *   … --chains=ethereum,bsc
 */
import { assertRuntimeMode, config } from "../../src/config";
import { bootstrapChains } from "../../src/chains/devnet";
import { prisma } from "../../src/db";
import { liquidateForward, swapToUsdt, unlockTransfer } from "../../src/orchestrator/service";
import { markConfirmed } from "../../src/transactions/service";
import { runMintCycle } from "../../src/treasury/mint-cycle";
import { mintCapacityRaw } from "../../src/treasury/reserve";
import { fromRaw, toRaw, txLink, type ChainName } from "../../src/shared";
import {
  GateReport,
  banner,
  gate4Recipient,
  requiredConfirmations,
  rpcEnvName,
  rpcUrl,
  secondaryRpcUrl,
  shortError,
  targetChains,
} from "./lib/env";
import { provider as rpcProvider, readWusdt, tokenBalance } from "./lib/fleet";

/** The smoke size — real money, small enough to lose. */
const SMOKE_LOCK_USD = 10_000;
const TRANSFER_OUT = "100"; // wUSDT out to the external address
const SWAP_AMOUNT = "500"; // wUSDT → USDT on the DEX
const SWAP_MIN_OUT = "495"; // 1 % floor on a peg swap
const FORWARD_AMOUNT = "100"; // USDT forwarded out of the liquidation
const SLIPPAGE_BPS = 100;
const RECEIPT_TIMEOUT_MS = 15 * 60_000;

const chains = targetChains();
const report = new GateReport("gate4-smoke");

banner("GATE 4 — smoke cycle (real funds)", [
  `chains: ${chains.join(", ")}`,
  `per chain: $${SMOKE_LOCK_USD} attested reserve · $${TRANSFER_OUT} transfer-out · $${SWAP_AMOUNT} swap · $${FORWARD_AMOUNT} forwarded`,
]);

if (config.chainMode !== "live") {
  report.fail("env", "CHAIN_MODE=live", `CHAIN_MODE=${config.chainMode} — the smoke cycle only runs against mainnet`);
  report.finish({ chains });
}
assertRuntimeMode();

const recipient = gate4Recipient();
if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
  report.fail(
    "env",
    "GATE4_EXTERNAL_ADDRESS is a valid EVM address",
    recipient ? `got "${recipient}"` : "not set — the cycle needs an ops-owned address to transfer out to",
  );
  report.finish({ chains });
}

// Register the live deployment + wallet rows from the environment (no deploy).
await bootstrapChains();

for (const chain of chains) await runChain(chain);

if (report.failures.length === 0) {
  console.log("\nALL CHAINS PASS → authorized to raise the caps to the full $10M target via the governor multisig");
  console.log("(manual, dual-approval). The full per-chain cycle then runs from the console: POST /api/treasury/refill.");
}
report.finish({ chains, recipient });

async function runChain(chain: ChainName): Promise<void> {
  const startedAt = new Date();
  try {
    const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
    if (!deployment || deployment.mode !== "live") throw new Error(`no live deployment registered for ${chain}`);
    const treasury = await prisma.wallet.findFirst({ where: { chain, kind: "treasury" } });
    if (!treasury) throw new Error(`no treasury wallet registered for ${chain}`);

    const usdtDecimals = deployment.usdtDecimals;
    const wusdtDecimals = deployment.wusdtDecimals;
    const primary = rpcProvider(rpcUrl(chain));

    // ── step 1: the reserve this cycle is minted against, read from chain ────
    const { capacityRaw, custodyRaw, supplyRaw } = await mintCapacityRaw({
      chain,
      wusdt: deployment.wusdt,
      usdt: deployment.usdt,
      custodyAddress: treasury.address,
    });
    const lockRaw = BigInt(toRaw(SMOKE_LOCK_USD, usdtDecimals));
    if (capacityRaw < lockRaw) {
      throw new Error(
        `attested reserve short: un-minted capacity ${fromRaw(capacityRaw, usdtDecimals)} USDT < ${SMOKE_LOCK_USD} ` +
          `(custody ${fromRaw(custodyRaw, usdtDecimals)}, supply ${fromRaw(supplyRaw, wusdtDecimals)})`,
      );
    }
    report.record(chain, "step 1 — attested reserve covers the smoke cycle", true, `${fromRaw(capacityRaw, usdtDecimals)} USDT un-minted capacity`);

    const recipientUsdtBefore = await tokenBalance(primary, deployment.usdt, recipient);
    const appWalletCount = await prisma.wallet.count({ where: { chain, kind: "app" } });

    // ── steps 2 + 3: mint the small cycle, then the 25 % split ───────────────
    const cycle = await runMintCycle(chain, SMOKE_LOCK_USD);
    if (!cycle.mintTxId || BigInt(cycle.mintedRaw) <= 0n) throw new Error("the mint cycle produced no supply");
    report.record(chain, "step 2 — small mint cycle completed", true, `${fromRaw(cycle.mintedRaw, wusdtDecimals)} wUSDT minted (cycle #${cycle.cycleIndex})`);
    if (appWalletCount === 0) {
      report.note(chain, "step 3 — 25 % distribution", "no app wallets configured (APP_WALLET_ADDRESSES unset) — not exercised");
    } else {
      report.record(
        chain,
        "step 3 — 25 % distributed to the app wallets",
        BigInt(cycle.distributedRaw) > 0n,
        `${fromRaw(cycle.distributedRaw, wusdtDecimals)} wUSDT across ${appWalletCount} wallet(s)`,
      );
    }

    // ── step 4: transfer-out to the ops-owned external address ───────────────
    const out = await unlockTransfer({ adminId: null, chain, walletId: treasury.id, toExternal: recipient, amountHuman: TRANSFER_OUT });
    report.record(chain, "step 4 — transfer-out broadcast", true, `${TRANSFER_OUT} wUSDT → ${recipient} · ${out.hash}`);

    // ── step 5: swap wUSDT → USDT through the chain's real DEX ───────────────
    const swap = await swapToUsdt({ adminId: null, chain, walletId: treasury.id, amountHuman: SWAP_AMOUNT, minOutHuman: SWAP_MIN_OUT });
    report.record(chain, "step 5 — swap wUSDT→USDT broadcast", true, `${swap.amountHuman} wUSDT via ${swap.dex} · ${swap.hash}`);

    // ── step 6: liquidate, then forward what the swap actually produced ──────
    const liquidation = await liquidateForward({
      adminId: null,
      chain,
      walletId: treasury.id,
      toExternal: recipient,
      amountHuman: FORWARD_AMOUNT,
      slippageBps: SLIPPAGE_BPS,
    });
    report.record(chain, "step 6 — liquidate & forward broadcast", true, `${liquidation.proceedsHuman} USDT forwarded · ${liquidation.forward.hash}`);

    // ── step 7: verification ─────────────────────────────────────────────────
    const rows = await prisma.transaction.findMany({ where: { chain, createdAt: { gte: startedAt } }, orderBy: { createdAt: "asc" } });
    if (rows.length === 0) throw new Error("no ledger rows were created for this run");
    const hashed = rows.filter((row) => row.hash);
    report.record(chain, "step 7a — every broadcast carries a broadcaster hash", hashed.length === rows.length, `${hashed.length}/${rows.length} transactions hashed`);

    // 7b: re-read every receipt from an independent endpoint and drive the
    // platform's own handshake for each hash.
    const secondary = secondaryRpcUrl(chain);
    const verifier = rpcProvider(secondary || rpcUrl(chain));
    report.note(chain, "step 7b — independent receipt re-read", secondary ? `${rpcEnvName(chain)}_2` : `${rpcEnvName(chain)} (no secondary endpoint configured)`);

    const required = requiredConfirmations(chain);
    for (const row of hashed) {
      const hash = row.hash as string;
      let confirmations = 0;
      try {
        const receipt = await verifier.waitForTransaction(hash, required, RECEIPT_TIMEOUT_MS);
        if (!receipt || receipt.status !== 1) throw new Error("receipt missing or reverted on chain");
        confirmations = (await verifier.getBlockNumber()) - receipt.blockNumber + 1;

        const current = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status !== "confirmed") {
          await markConfirmed(hash, {
            blockNumber: receipt.blockNumber,
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            confirmations,
          });
        }
      } catch (err) {
        report.fail(chain, `step 7b — ${row.direction} confirmed on chain`, `${hash}: ${shortError(err)}`);
        continue;
      }

      const confirmed = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
      report.record(
        chain,
        `step 7b — ${row.direction} confirmed (${confirmations}/${required})`,
        confirmed.status === "confirmed" && Boolean(confirmed.explorerUrl),
        `${hash} · ${confirmed.explorerUrl ?? "no explorer link"}`,
      );
    }

    // 7c: the chain's supply grew by exactly the minted amount.
    const supplyAfter = (await readWusdt(primary, deployment.wusdt)).totalSupply;
    report.record(
      chain,
      "step 7c — chain supply grew by exactly the minted amount",
      supplyAfter - supplyRaw === BigInt(cycle.mintedRaw),
      `${fromRaw(supplyAfter - supplyRaw, wusdtDecimals)} wUSDT added vs ${fromRaw(cycle.mintedRaw, wusdtDecimals)} minted`,
    );

    // 7d: the forwarded USDT really landed at the external address.
    const recipientUsdtAfter = await tokenBalance(primary, deployment.usdt, recipient);
    report.record(
      chain,
      "step 7d — USDT arrived at the external address",
      recipientUsdtAfter - recipientUsdtBefore >= BigInt(liquidation.proceedsRaw),
      `${fromRaw(recipientUsdtAfter - recipientUsdtBefore, usdtDecimals)} USDT received vs ${liquidation.proceedsHuman} forwarded`,
    );

    // 7e: the receipt webhooks fired, when a subscription exists.
    const subscriptions = await prisma.webhookSubscription.count({ where: { active: true } });
    if (subscriptions === 0) {
      report.note(chain, "step 7e — webhook deliveries", "no active webhook subscription — nothing to deliver");
    } else {
      const deliveries = await prisma.webhookDelivery.findMany({ where: { createdAt: { gte: startedAt } } });
      report.record(chain, "step 7e — webhook deliveries recorded", deliveries.length > 0, `${deliveries.length} delivery row(s)`);
    }

    // 7f: explorer deep link, derived from the hash — informational, because
    // public explorers rate-limit automated requests.
    const probeHash = hashed[0]?.hash;
    if (probeHash) {
      const url = txLink(chain, probeHash);
      const probe = await fetch(url, { method: "HEAD" }).catch(() => null);
      report.note(chain, "step 7f — explorer deep link probe", probe ? `HTTP ${probe.status} ${url}` : `no response from ${url}`);
    }
  } catch (err) {
    report.fail(chain, "smoke cycle", shortError(err));
  }
}
