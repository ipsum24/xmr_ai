/**
 * Launch-gate environment and reporting helpers.
 *
 * The gates read the environment DIRECTLY instead of importing the app's
 * `config` module: config throws on the first missing variable, so a pre-flight
 * on a machine that is not configured yet would crash instead of reporting
 * everything that is still missing. The variable NAMES are the ones live mode
 * reads, so what passes a gate is exactly what the API needs to boot.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAIN_REGISTRY, CONFIRMATIONS, fromRaw, type ChainName } from "../../../src/shared";

/** The launch covers the EVM fleet; TRON's signer and SunSwap path are not built yet. */
export const EVM_LAUNCH_CHAINS: ChainName[] = ["ethereum", "bsc", "arbitrum", "polygon"];

const RPC_ENV: Record<ChainName, string> = {
  ethereum: "ETH_RPC",
  bsc: "BSC_RPC",
  arbitrum: "ARB_RPC",
  polygon: "POLY_RPC",
  tron: "TRON_FULLHOST",
};

const REPORT_DIR = fileURLToPath(new URL("../../../../../reports/launch/", import.meta.url));

export function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Chains this run covers: `--chains=ethereum,bsc`, else LAUNCH_CHAINS, else the
 * whole EVM fleet. TRON is rejected — it would silently produce a half-broken
 * launch, since only the EVM broadcaster path is implemented.
 */
export function targetChains(argv: readonly string[] = process.argv): ChainName[] {
  const flag = argv.find((arg) => arg.startsWith("--chains="));
  const raw = flag ? flag.slice("--chains=".length) : env("LAUNCH_CHAINS") || EVM_LAUNCH_CHAINS.join(",");
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("no launch chains selected");

  const unknown = names.filter((name) => !EVM_LAUNCH_CHAINS.includes(name as ChainName));
  if (unknown.length > 0) {
    throw new Error(`not an EVM launch chain: ${unknown.join(", ")} (supported: ${EVM_LAUNCH_CHAINS.join(", ")})`);
  }
  return names as ChainName[];
}

export function rpcEnvName(chain: ChainName): string {
  return RPC_ENV[chain];
}

export function rpcUrl(chain: ChainName): string {
  return env(RPC_ENV[chain]);
}

/** Optional second endpoint: the independent receipt re-read in Gate 4 uses it. */
export function secondaryRpcUrl(chain: ChainName): string {
  return env(`${RPC_ENV[chain]}_2`);
}

export function custodyKey(): string {
  return env("LIVE_SIGNER_PRIVATE_KEY");
}

export function wusdtAddress(chain: ChainName): string {
  return env(`WUSDT_${chain.toUpperCase()}`);
}

/** The TreasuryVault that holds wUSDT's minter role — Gate 1 prints it. */
export function vaultAddress(chain: ChainName): string {
  return env(`TREASURY_VAULT_${chain.toUpperCase()}`);
}

/** The reserve ceiling a fresh vault is launched with ($10M by default). */
export function reserveTargetUsd(): number {
  return Number(env("TREASURY_VAULT_TARGET_USD") || "10000000");
}

export function swapRouter(chain: ChainName): string {
  return env(`SWAP_ROUTER_${chain.toUpperCase()}`);
}

export function swapDexName(chain: ChainName): string {
  return env(`SWAP_DEX_${chain.toUpperCase()}`) || "dex";
}

/** Optional multisig that takes governance once the fleet is deployed. */
export function finalGovernor(): string {
  return env("LAUNCH_GOVERNOR");
}

/** Ops-owned external address the Gate 4 cycle transfers out to. */
export function gate4Recipient(): string {
  return env("GATE4_EXTERNAL_ADDRESS");
}

/**
 * Wallets that receive the native-gas float on a chain: `GAS_FORWARD_TO_<CHAIN>`
 * overrides `GAS_FORWARD_TO`, which falls back to the app wallets. These are the
 * addresses that sign and pay for their own transactions, so each needs gas of
 * its own — the custody key never pays a third party's fee for it.
 */
export function gasForwardTargets(chain: ChainName): string[] {
  const scoped = env(`GAS_FORWARD_TO_${chain.toUpperCase()}`);
  const raw = scoped || env("GAS_FORWARD_TO") || env("APP_WALLET_ADDRESSES");
  return [...new Set(raw.split(",").map((address) => address.trim()).filter(Boolean))];
}

export function label(chain: ChainName): string {
  return CHAIN_REGISTRY[chain].label;
}

/** Tether's own USDT contract on this chain, from the chain registry. */
export function usdtAddress(chain: ChainName): string {
  return CHAIN_REGISTRY[chain].usdt;
}

export function usdtDecimals(chain: ChainName): number {
  return CHAIN_REGISTRY[chain].usdtDecimals;
}

export function registryChainId(chain: ChainName): number {
  return CHAIN_REGISTRY[chain].chainId;
}

export function requiredConfirmations(chain: ChainName): number {
  return CONFIRMATIONS[chain];
}

export function explorerTxUrl(chain: ChainName, hash: string): string {
  return `${CHAIN_REGISTRY[chain].explorerBase}/tx/${hash}`;
}

export function human(raw: bigint | string, decimals: number): string {
  return fromRaw(raw, decimals);
}

/** One-line, transcript-safe error text for logs and reports. */
export function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split("\n")[0]?.slice(0, 300) ?? "unknown error";
}

export interface CheckResult {
  scope: string;
  name: string;
  ok: boolean;
  /** Informational results print but never fail a gate. */
  info?: boolean;
  detail?: string;
}

/**
 * Collects a gate's checks, prints them, and writes a JSON report next to the
 * repo root so a launch leaves an artifact behind. Nothing here decides
 * pass/fail on its own — the caller records a check per assertion.
 */
export class GateReport {
  private readonly results: CheckResult[] = [];

  constructor(private readonly gate: string) {}

  record(scope: string, name: string, ok: boolean, detail?: string): boolean {
    this.results.push({ scope, name, ok, detail });
    return ok;
  }

  fail(scope: string, name: string, detail: string): void {
    this.record(scope, name, false, detail);
  }

  /** Reported for the operator, but not a launch blocker. */
  note(scope: string, name: string, detail: string): void {
    this.results.push({ scope, name, ok: true, info: true, detail });
  }

  get failures(): CheckResult[] {
    return this.results.filter((result) => !result.ok && !result.info);
  }

  get passedCount(): number {
    return this.results.filter((result) => result.ok && !result.info).length;
  }

  /** Print the summary, persist the report, and exit 1 when anything failed. */
  finish(details: Record<string, unknown> = {}): void {
    const failures = this.failures;
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const file = `${REPORT_DIR}${this.gate}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(file, JSON.stringify({ gate: this.gate, at: new Date().toISOString(), results: this.results, ...details }, null, 2));

    for (const result of this.results) {
      const mark = result.info ? "·" : result.ok ? "✓" : "✗";
      console.log(`${mark} [${result.scope}] ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
    }

    if (failures.length > 0) {
      console.log(`\n✗ ${this.gate} FAILED — ${failures.length} blocker(s), ${this.passedCount} check(s) passed.`);
      console.log(`  report: ${file}`);
      process.exit(1);
    }
    console.log(`\n✓ ${this.gate} PASSED — ${this.passedCount} check(s), report: ${file}`);
  }
}

export function banner(gate: string, lines: readonly string[]): void {
  console.log(`\n═══ ${gate} ═══`);
  for (const line of lines) console.log(line);
}
