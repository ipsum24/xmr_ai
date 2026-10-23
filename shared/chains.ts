/**
 * Chain registry — the single source of truth for every chain the platform
 * touches, shared by the API, the workers and the dashboard.
 *
 * ⚠️ Official USDT decimals differ per chain: BSC is 18, everything else is 6.
 * Every amount conversion MUST go through the registry decimals
 * (`toRaw(amount, CHAIN_REGISTRY[chain].decimals)`) — never a hardcoded 1e6.
 */

export type ChainName = "ethereum" | "bsc" | "tron" | "arbitrum" | "polygon";
export type ChainFamily = "evm" | "tron";

export interface ChainConfig {
  /** EVM chain id; TRON has no EVM chain id (-1). */
  readonly chainId: number;
  readonly family: ChainFamily;
  readonly label: string;
  /** Official Tether USDT contract on this chain. */
  readonly usdt: string;
  readonly usdtDecimals: number;
  /** Public block explorer base (empty when the chain runs on a local devnet). */
  readonly explorerBase: string;
}

export const CHAIN_REGISTRY: Record<ChainName, ChainConfig> = {
  ethereum: {
    chainId: 1,
    family: "evm",
    label: "Ethereum",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    usdtDecimals: 6,
    explorerBase: "https://etherscan.io",
  },
  bsc: {
    chainId: 56,
    family: "evm",
    label: "BNB Chain",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    usdtDecimals: 18, // ← the 18-decimal trap: BSC USDT is NOT 6 decimals
    explorerBase: "https://bscscan.com",
  },
  tron: {
    chainId: -1,
    family: "tron",
    label: "TRON",
    usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    usdtDecimals: 6,
    explorerBase: "https://tronscan.org",
  },
  arbitrum: {
    chainId: 42161,
    family: "evm",
    label: "Arbitrum One",
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    usdtDecimals: 6,
    explorerBase: "https://arbiscan.io",
  },
  polygon: {
    chainId: 137,
    family: "evm",
    label: "Polygon",
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    usdtDecimals: 6,
    explorerBase: "https://polygonscan.com",
  },
};

export const CHAIN_NAMES = Object.keys(CHAIN_REGISTRY) as ChainName[];

/** Per-chain receipt confirmations before a transaction is treated as final. */
export const CONFIRMATIONS: Record<ChainName, number> = {
  ethereum: 12,
  bsc: 15,
  arbitrum: 60,
  polygon: 128,
  tron: 19,
};

export function isChainName(value: string): value is ChainName {
  return Object.prototype.hasOwnProperty.call(CHAIN_REGISTRY, value);
}

export function chainConfig(chain: ChainName): ChainConfig {
  return CHAIN_REGISTRY[chain];
}
