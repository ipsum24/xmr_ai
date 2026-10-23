export interface ApiError {
  error: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message = (payload as ApiError | null)?.error ?? `request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
};

// ── types shared with the console ──────────────────────────────────────────
export interface Admin {
  id: string;
  email: string;
  name: string | null;
}

export interface Balance {
  tokenId: string;
  symbol: string;
  decimals: number;
  availableRaw: string;
  availableHuman: string;
}

export interface Wallet {
  id: string;
  chain: string;
  address: string;
  label: string;
  kind: "treasury" | "app";
  balances: Balance[];
}

export interface ChainInfo {
  chain: string;
  label: string;
  chainId: number;
  family: string;
  mode: string;
  status: "ready" | "awaiting_rpc";
  usdt: string;
  usdtDecimals: number;
  wusdt: string;
  dexRouter: string;
  dexName: string;
  explorerBase: string | null;
  reserve: {
    custodyRaw: string | null;
    supplyRaw: string | null;
    capacityRaw: string | null;
    custodyHuman: string | null;
    supplyHuman: string | null;
    capacityHuman: string | null;
  };
  wallets: Wallet[];
}

export interface ChainFleet {
  mode: string;
  targets: string[];
  chains: ChainInfo[];
}

export interface MintCycle {
  id: string;
  chain: string;
  cycleIndex: number;
  targetRaw: string;
  attestedRaw: string;
  mintedRaw: string;
  distributedRaw: string;
  status: "running" | "completed" | "failed" | "skipped";
  error: string | null;
  mintTxId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ChainCycles {
  chain: string;
  chainId: number;
  mode: string;
  decimals: number;
  targetRaw: string;
  targetUsd: number;
  cycles: number;
  latestCycle: MintCycle | null;
  mintedTotalRaw: string;
  utilizationBps: number;
  distributionBps: number;
}

export interface TransactionRecord {
  id: string;
  chain: string;
  direction: string;
  status: "pending_broadcast" | "broadcasting" | "confirmed" | "failed";
  hash: string | null;
  hashSource: string | null;
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenSymbol: string;
  decimals: number;
  blockNumber: number | null;
  gasUsed: string | null;
  confirmations: number;
  confirmedAt: string | null;
  explorerUrl: string | null;
  failureReason: string | null;
  note: string | null;
  createdAt: string;
}

export interface BroadcastResult {
  txId: string;
  hash: string;
  status: string;
  chain: string;
  direction: string;
  amountRaw: string;
  amountHuman: string;
  tokenSymbol: string;
  explorerUrl: string | null;
  dex?: string;
  approvalTxId?: string;
}

export interface CollateralAsset {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceRaw8: string;
  haircutBps: number;
  ltvBps: number;
  approved: boolean;
}

export interface LoanQuote {
  chain: string;
  term: string;
  termLabel: string;
  days: number;
  aprBps: number;
  principalHuman: string;
  interestHuman: string;
  totalRepayHuman: string;
  requiredCollateralHuman: string;
  effectiveAprPct: number;
  collateral: CollateralAsset;
}

export interface Loan {
  id: string;
  chain: string;
  borrowerAddress: string;
  collateralSymbol: string;
  collateralAmount: string;
  principalRaw: string;
  aprBps: number;
  term: string;
  interestDueRaw: string;
  totalRepayRaw: string;
  startAt: string;
  maturityAt: string;
  status: string;
  disbursementTxId: string | null;
  repaymentTxId: string | null;
}

export interface TermTier {
  term: string;
  days: number;
  aprBps: number;
  label: string;
}
