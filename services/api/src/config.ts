import "dotenv/config";
import { isChainName, type ChainName } from "./shared";

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const chainTargets = str("CHAIN_TARGETS", "ethereum,bsc,arbitrum,polygon")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
for (const chain of chainTargets) {
  if (!isChainName(chain)) throw new Error(`CHAIN_TARGETS contains an unknown chain: ${chain}`);
}

/** Local devnet node per chain (the compose stack runs one Anvil per EVM chain). */
const DEVNET_DEFAULT_RPC: Record<ChainName, string> = {
  ethereum: "http://anvil-ethereum:8545",
  bsc: "http://anvil-bsc:8545",
  arbitrum: "http://anvil-arbitrum:8545",
  polygon: "http://anvil-polygon:8545",
  tron: "",
};

/** Live mode reads the real RPC from the secret store. */
const LIVE_RPC_ENV: Record<ChainName, string> = {
  ethereum: "ETH_RPC",
  bsc: "BSC_RPC",
  arbitrum: "ARB_RPC",
  polygon: "POLY_RPC",
  tron: "TRON_FULLHOST",
};

const chainMode = str("CHAIN_MODE", "devnet") as "devnet" | "live";
if (chainMode !== "devnet" && chainMode !== "live") {
  throw new Error(`CHAIN_MODE must be "devnet" or "live" (got "${chainMode}")`);
}

const rpcUrls = {} as Record<ChainName, string>;
for (const chain of chainTargets as ChainName[]) {
  const rpc =
    chainMode === "devnet"
      ? process.env[`ANVIL_RPC_${chain.toUpperCase()}`] || DEVNET_DEFAULT_RPC[chain]
      : process.env[LIVE_RPC_ENV[chain]] ?? "";
  if (!rpc) {
    throw new Error(`${LIVE_RPC_ENV[chain]} is required for chain "${chain}" in ${chainMode} mode`);
  }
  rpcUrls[chain] = rpc;
}

export const config = {
  nodeEnv: str("NODE_ENV", "development"),
  port: Number(str("PORT", "4000")),
  databaseUrl: str("DATABASE_URL", "postgresql://wusdt:wusdt@localhost:5432/wusdt"),
  jwtSecret: str("JWT_SECRET", "wusdt-dev-only-insecure-jwt-secret"),
  /** devnet = local Anvil chains; live = real RPCs from the secret store. */
  chainMode,
  chainTargets: chainTargets as ChainName[],
  rpcUrls,
  contractsDir: str("CONTRACTS_DIR", "../../contracts/src"),
  /** Local devnet keys only. Live mode never uses this — see liveSignerKey. */
  devMnemonic: str("DEV_MNEMONIC", "test test test test test test test test test test test junk"),
  /** Live mode custody key (KMS signer is the production target — see README gaps). */
  liveSignerKey: process.env.LIVE_SIGNER_PRIVATE_KEY ?? "",
  adminEmail: str("ADMIN_EMAIL", "quantumxx0@gmail.com"),
  adminInitialPassword: str("ADMIN_INITIAL_PASSWORD", "wusdt-admin-2026"),
  /** Mint cycle target per chain: $10,000,000. */
  treasuryVaultTargetUsd: Number(str("TREASURY_VAULT_TARGET_USD", "10000000")),
  /** Share of each cycle pushed out to the app wallets: 25 %. */
  appWalletDistributionBps: Number(str("APP_WALLET_DISTRIBUTION_BPS", "2500")),
  /** Local chains produce a block per transaction, so one confirmation is final. */
  devnetConfirmations: Number(str("DEVNET_CONFIRMATIONS", "1")),
  sessionTtlHours: Number(str("SESSION_TTL_HOURS", "12")),
  base44PreviewMode: process.env.BASE44_PREVIEW_MODE === "1",
};

/**
 * Real-data guard (from the build spec): in production a mock/simulate/demo
 * switch present in the environment, a non-live chain mode, or a testnet RPC
 * must abort the boot rather than let synthetic data reach the runtime path.
 * The Foundry test suite keeps its mocks — this guards the runtime only.
 */
export function assertRuntimeMode(): void {
  if (config.nodeEnv !== "production") return;

  const banned = ["MOCK_", "SIMULATE_", "FAKE_", "DEMO_MODE", "SEED_DEMO"];
  for (const key of Object.keys(process.env)) {
    if (banned.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`Banned env ${key} present in production`);
    }
  }
  if (config.chainMode !== "live") {
    throw new Error("CHAIN_MODE must be live in production");
  }
  if (/sepolia|goerli|amoy|shasta|nile|testnet/i.test(JSON.stringify(config.rpcUrls))) {
    throw new Error("Non-mainnet RPC configured in production");
  }
}

export type AppConfig = typeof config;
