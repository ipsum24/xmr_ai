import { prisma } from "../db";
import { explorerUrlFor, type ChainName, type ChainConfig, CHAIN_REGISTRY } from "../shared";
import { queueReceiptWebhooks, type WebhookableTransaction } from "../webhooks/service";

export interface NewTransactionInput {
  chain: ChainName;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenId: string;
  tokenSymbol: string;
  decimals: number;
  adminInitiated?: boolean;
  initiatedByAdminId?: string | null;
  note?: string;
}

export async function createTransaction(input: NewTransactionInput) {
  return prisma.transaction.create({
    data: {
      chain: input.chain,
      direction: input.direction,
      status: "pending_broadcast",
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      amount: input.amount,
      tokenId: input.tokenId,
      tokenSymbol: input.tokenSymbol,
      decimals: input.decimals,
      adminInitiated: input.adminInitiated ?? true,
      initiatedByAdminId: input.initiatedByAdminId ?? null,
      note: input.note ?? null,
    },
  });
}

/**
 * The ONLY entry point that sets a hash, called exclusively by the broadcaster
 * after the node accepted the transaction. Write-once: a second, different hash
 * can never replace the first one, and no HTTP route accepts a hash as input.
 */
export async function attachHash(txId: string, hash: string, source: "broadcaster:evm" | "broadcaster:tron") {
  const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
  if (tx.hash && tx.hash !== hash) throw new Error(`hash already attached to ${txId}`);
  return prisma.transaction.update({
    where: { id: txId },
    data: { hash, hashSource: source, status: "broadcasting" },
  });
}

export async function markFailedById(txId: string, reason: string) {
  return prisma.transaction.update({
    where: { id: txId },
    data: { status: "failed", failureReason: reason.slice(0, 500) },
  });
}

export async function markFailed(hash: string, reason: string) {
  return prisma.transaction.update({
    where: { hash },
    data: { status: "failed", failureReason: reason.slice(0, 500) },
  });
}

/** Handshake confirms a receipt — flips status and DERIVES the explorer link. */
export async function markConfirmed(
  hash: string,
  receipt: { blockNumber: number; status: number; gasUsed?: bigint | null; confirmations?: number },
) {
  const tx = await prisma.transaction.findUniqueOrThrow({ where: { hash } });
  if (receipt.status !== 1) {
    return markFailed(hash, "transaction reverted on chain");
  }

  const deployment = await prisma.chainDeployment.findUnique({ where: { chain: tx.chain } });
  const chain = tx.chain as ChainName;
  const explorerUrl = deployment
    ? explorerUrlFor(chain, hash, deployment.explorerBase)
    : explorerUrlFor(chain, hash);

  const updated = await prisma.transaction.update({
    where: { hash },
    data: {
      status: "confirmed",
      confirmedAt: new Date(),
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
      confirmations: receipt.confirmations ?? 1,
      explorerUrl,
    },
  });

  await queueReceiptWebhooks(updated as unknown as WebhookableTransaction);
  return updated;
}

export interface TransactionFilters {
  chain?: ChainName;
  status?: string;
  direction?: string;
  limit?: number;
}

export async function listTransactions(filters: TransactionFilters = {}) {
  return prisma.transaction.findMany({
    where: {
      ...(filters.chain ? { chain: filters.chain } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 50, 200),
  });
}

export async function getTransaction(id: string) {
  const tx = await prisma.transaction.findUnique({ where: { id } });
  if (!tx) return null;
  const chain = tx.chain as ChainName;
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  const config: ChainConfig = CHAIN_REGISTRY[chain];
  return {
    ...tx,
    chainLabel: config?.label ?? tx.chain,
    explorerUrl: tx.explorerUrl ?? (tx.hash ? explorerUrlFor(chain, tx.hash, deployment?.explorerBase) : null),
  };
}

export function tokenSymbolFor(chain: ChainName): string {
  return CHAIN_REGISTRY[chain].usdtDecimals === 18 ? "USDT" : "USDT";
}
