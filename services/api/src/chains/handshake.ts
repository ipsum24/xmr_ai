import { config } from "../config";
import { prisma } from "../db";
import { CONFIRMATIONS, type ChainName } from "../shared";
import { markConfirmed, markFailed } from "../transactions/service";
import { providerFor } from "./rpc";
import { syncBalances } from "./wallets";

/** A broadcast that never gets a receipt is treated as dropped. */
const RECEIPT_WINDOW_MS = 10 * 60 * 1000;
const SCAN_INTERVAL_MS = 3_000;

export function requiredConfirmations(chain: ChainName): number {
  return config.chainMode === "devnet" ? config.devnetConfirmations : CONFIRMATIONS[chain];
}

/**
 * On-chain handshake: every broadcast is watched to N confirmations against the
 * contract it was actually sent to. When the receipt lands with status 1 the
 * transaction flips to `confirmed`, the explorer link is derived, receipt
 * webhooks fire and the affected chain's balances are re-read from chain.
 */
export function startHandshakeWatcher(intervalMs = SCAN_INTERVAL_MS): NodeJS.Timeout {
  console.log("[handshake] watching broadcasts for on-chain receipts");
  void scanOnce();
  const timer = setInterval(() => void scanOnce(), intervalMs);
  timer.unref();
  return timer;
}

/**
 * Block until a specific broadcast is mined (used when one step of a chained
 * operation needs the real result of the previous step — e.g. liquidate-forward
 * measures the USDT the swap actually produced).
 */
export async function awaitReceipt(chain: ChainName, hash: string, timeoutMs = 60_000) {
  const provider = providerFor(chain);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>> = null;
    try {
      receipt = await provider.getTransactionReceipt(hash);
    } catch {
      receipt = null;
    }
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`transaction ${hash} reverted on chain`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for the receipt of ${hash}`);
}

export async function scanOnce(): Promise<void> {  try {
    const inFlight = await prisma.transaction.findMany({
      where: { status: "broadcasting", hash: { not: null } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    const touchedChains = new Set<string>();

    for (const tx of inFlight) {
      const chain = tx.chain as ChainName;
      const hash = tx.hash as string;

      let receipt: Awaited<ReturnType<ReturnType<typeof providerFor>["getTransactionReceipt"]>> = null;
      try {
        receipt = await providerFor(chain).getTransactionReceipt(hash);
      } catch (err) {
        console.error(`[handshake] receipt lookup failed for ${hash}`, err);
        continue;
      }

      if (!receipt) {
        if (Date.now() - tx.createdAt.getTime() > RECEIPT_WINDOW_MS) {
          await markFailed(hash, "no receipt within 10 minutes");
        }
        continue;
      }

      if (receipt.status !== 1) {
        await markFailed(hash, "transaction reverted on chain");
        continue;
      }

      const head = await providerFor(chain).getBlockNumber();
      const confirmations = head - receipt.blockNumber + 1;
      const required = requiredConfirmations(chain);

      if (confirmations >= required) {
        await markConfirmed(hash, {
          blockNumber: receipt.blockNumber,
          status: receipt.status,
          gasUsed: receipt.gasUsed,
          confirmations,
        });
        touchedChains.add(chain);
      } else {
        await prisma.transaction.update({ where: { id: tx.id }, data: { confirmations } });
      }
    }

    for (const chain of touchedChains) {
      await syncBalances(chain as ChainName);
    }
  } catch (err) {
    console.error("[handshake] scan failed", err);
  }
}
