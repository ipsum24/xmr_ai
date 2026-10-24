/**
 * GATE 0 — pre-flight (fails closed).
 *
 * Nothing is deployed or broadcast here. This gate proves the machine is set up
 * for a REAL mainnet launch: live mode, production, no mock/simulate switches,
 * a custody key that can pay gas, and every chain answering as the mainnet the
 * chain registry says it is. The chain id is read from the RPC and compared with
 * the registry, so a test-network endpoint cannot pass as production — even one
 * whose URL looks innocent.
 *
 * Run inside the API container (it has the environment and the network):
 *   docker compose exec -T api npx tsx services/api/scripts/launch/preflight.ts
 *   … --chains=ethereum,bsc
 */
import { env, GateReport, banner, custodyKey, human, label, registryChainId, rpcEnvName, rpcUrl, shortError, swapDexName, swapRouter, targetChains, usdtAddress, usdtDecimals, wusdtAddress } from "./lib/env";
import { addressForKey, chainIdOf, codePresent, nativeBalance, provider, readToken } from "./lib/fleet";

const BANNED_ENV_PREFIXES = ["MOCK_", "SIMULATE_", "FAKE_", "DEMO_MODE", "SEED_DEMO"];
const TESTNET_HINT = /sepolia|goerli|holesky|amoy|shasta|nile|testnet|devnet|localhost|127\.0\.0\.1/i;

const chains = targetChains();
const report = new GateReport("gate0-preflight");
banner("GATE 0 — pre-flight", [`chains: ${chains.join(", ")}`, "no transactions are sent by this gate"]);

// ── runtime mode ────────────────────────────────────────────────────────────
const mode = env("CHAIN_MODE");
report.record("env", "CHAIN_MODE=live", mode === "live", mode ? `CHAIN_MODE=${mode}` : "not set");

const nodeEnv = env("NODE_ENV");
report.record("env", "NODE_ENV=production", nodeEnv === "production", nodeEnv ? `NODE_ENV=${nodeEnv}` : "not set");

const bannedHits = Object.keys(process.env).filter((key) => BANNED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)));
report.record("env", "no mock/simulate switches present", bannedHits.length === 0, bannedHits.join(", "));

const databaseUrl = env("DATABASE_URL");
report.record("env", "DATABASE_URL set (Gate 4 writes the ledger)", databaseUrl !== "", databaseUrl ? "set" : "not set");

// ── custody key ─────────────────────────────────────────────────────────────
const key = custodyKey();
let custodyAddress = "";
if (!key) {
  report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY set", "not set — the launch has no key to sign with");
} else {
  try {
    custodyAddress = addressForKey(key);
    report.record("custody", "LIVE_SIGNER_PRIVATE_KEY is a valid key", true, custodyAddress);
  } catch (err) {
    report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY is a valid key", shortError(err));
  }
}

// ── per chain ───────────────────────────────────────────────────────────────
for (const chain of chains) {
  const rpc = rpcUrl(chain);
  const rpcName = rpcEnvName(chain);
  if (!rpc) {
    report.fail(chain, `${rpcName} set`, `not set — ${label(chain)} mainnet endpoint required`);
    continue;
  }
  if (TESTNET_HINT.test(rpc)) {
    report.fail(chain, `${rpcName} is a mainnet endpoint`, "the URL contains a test-network hint");
  }

  const expectedChainId = registryChainId(chain);
  const p = provider(rpc);

  try {
    const actualChainId = await chainIdOf(p);
    report.record(
      chain,
      `RPC answers as ${label(chain)} (chain id ${expectedChainId})`,
      actualChainId === expectedChainId,
      actualChainId === expectedChainId ? `chain id ${actualChainId}` : `chain id ${actualChainId} — NOT mainnet`,
    );
    if (actualChainId !== expectedChainId) continue;

    const blockNumber = await p.getBlockNumber();
    report.record(chain, "RPC answers with a live block height", blockNumber > 0, `block ${blockNumber}`);
  } catch (err) {
    report.fail(chain, "RPC reachable", shortError(err));
    continue;
  }

  // Tether's own USDT — the reserve asset every mint is gated on.
  const usdt = usdtAddress(chain);
  try {
    if (await codePresent(p, usdt)) {
      const token = await readToken(p, usdt);
      const expectedDecimals = usdtDecimals(chain);
      report.record(
        chain,
        "official USDT decimals match the chain registry",
        token.decimals === expectedDecimals,
        `${token.symbol} at ${usdt} — ${token.decimals} decimals (registry: ${expectedDecimals})`,
      );
    } else {
      report.fail(chain, "official USDT contract has code", `no code at ${usdt}`);
    }
  } catch (err) {
    report.fail(chain, "official USDT readable", shortError(err));
  }

  // Gas for the launch transactions.
  if (custodyAddress) {
    try {
      const gas = await nativeBalance(p, custodyAddress);
      report.record(
        chain,
        "custody account holds gas for the launch transactions",
        gas > 0n,
        `${human(gas, 18)} native — ${custodyAddress}`,
      );
    } catch (err) {
      report.fail(chain, "custody gas balance readable", shortError(err));
    }
  }

  // Informational: what the later gates will need.
  const wusdt = wusdtAddress(chain);
  report.note(chain, "wUSDT address", wusdt ? `${wusdt} (Gate 2 will re-verify it)` : `WUSDT_${chain.toUpperCase()} not set — Gate 1 deploys it`);

  const router = swapRouter(chain);
  report.note(chain, "DEX router", router ? `${router} (${swapDexName(chain)})` : `SWAP_ROUTER_${chain.toUpperCase()} not set — Gate 4 swaps would abort`);
}

if (report.failures.length > 0) {
  console.log("\nProvide the missing values, then re-run this gate:");
  console.log("  CHAIN_MODE=live");
  console.log("  NODE_ENV=production");
  console.log("  LIVE_SIGNER_PRIVATE_KEY=…          # funded custody key (gas on every chain)");
  for (const chain of chains) {
    console.log(`  ${rpcEnvName(chain)}=…${" ".repeat(Math.max(0, 24 - rpcEnvName(chain).length))}# ${label(chain)} mainnet RPC`);
  }
  console.log("  WUSDT_<CHAIN>=0x…                  # from Gate 1, once deployed");
  console.log("  SWAP_ROUTER_<CHAIN>=0x…            # the chain's real DEX router");
}

report.finish({ chains, chainMode: mode });
