/**
 * GATE 2 — verify the fleet on chain (reads only).
 *
 * No transaction is sent here. Every assertion is a read against the mainnet
 * endpoints, so a fleet that is mis-configured, mis-signed or deployed with the
 * wrong decimals is rejected before any money moves:
 *
 *   · the RPC is the mainnet the chain registry names (chain id compared)
 *   · Tether's own USDT on that chain answers with the registry's decimals
 *     (the BSC 18-decimal trap is the point of this check)
 *   · the deployed wUSDT reads back as Wrapped USDT / wUSDT / same decimals
 *   · minter is the mint engine's key, governor is the launch multisig
 *   · the DEX router the swap path needs exists at the configured address
 *   · supply never exceeds the custodied USDT (the reserve invariant)
 *
 *   docker compose exec -T api npx tsx services/api/scripts/launch/verify-fleet.ts
 *   … --chains=ethereum,bsc
 */
import {
  custodyKey,
  finalGovernor,
  GateReport,
  banner,
  human,
  label,
  registryChainId,
  rpcEnvName,
  rpcUrl,
  shortError,
  swapDexName,
  swapRouter,
  targetChains,
  usdtAddress,
  usdtDecimals,
  wusdtAddress,
} from "./lib/env";
import { addressForKey, chainIdOf, codePresent, nativeBalance, provider, readToken, readWusdt, tokenBalance } from "./lib/fleet";
import { tokenLink } from "../../src/shared";

const WUSDT_NAME = "Wrapped USDT";
const WUSDT_SYMBOL = "wUSDT";

const chains = targetChains();
const report = new GateReport("gate2-verify-fleet");
banner("GATE 2 — verify fleet on chain", [`chains: ${chains.join(", ")}`, "read-only: no transactions are sent"]);

const key = custodyKey();
let custodyAddress = "";
if (key) {
  try {
    custodyAddress = addressForKey(key);
  } catch (err) {
    report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY is a valid key", shortError(err));
  }
} else {
  report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY set", "not set — cannot verify the minter role");
}
const expectedGovernor = (finalGovernor() || custodyAddress).toLowerCase();

for (const chain of chains) {
  const rpc = rpcUrl(chain);
  if (!rpc) {
    report.fail(chain, `${rpcEnvName(chain)} set`, "not set");
    continue;
  }

  const p = provider(rpc);

  try {
    const actualChainId = await chainIdOf(p);
    if (!report.record(chain, `RPC is ${label(chain)} (chain id ${registryChainId(chain)})`, actualChainId === registryChainId(chain), `chain id ${actualChainId}`)) {
      continue;
    }
  } catch (err) {
    report.fail(chain, "RPC reachable", shortError(err));
    continue;
  }

  // ── the reserve asset ─────────────────────────────────────────────────────
  const usdt = usdtAddress(chain);
  const expectedUsdtDecimals = usdtDecimals(chain);
  try {
    if (!(await codePresent(p, usdt))) {
      report.fail(chain, "official USDT contract has code", `no code at ${usdt} — this is not ${label(chain)} mainnet`);
    } else {
      const token = await readToken(p, usdt);
      report.record(
        chain,
        "official USDT decimals match the chain registry",
        token.decimals === expectedUsdtDecimals,
        `${token.symbol} — ${token.decimals} decimals (registry: ${expectedUsdtDecimals})`,
      );
    }
  } catch (err) {
    report.fail(chain, "official USDT readable", `${usdt}: ${shortError(err)}`);
  }

  // ── the deployed wUSDT ────────────────────────────────────────────────────
  const wusdt = wusdtAddress(chain);
  if (!wusdt) {
    report.fail(chain, `WUSDT_${chain.toUpperCase()} set`, "not set — run Gate 1 first");
    continue;
  }

  let supplyRaw = 0n;
  try {
    const read = await readWusdt(p, wusdt);
    const decimalsOk = read.decimals === expectedUsdtDecimals;
    const identityOk = read.name === WUSDT_NAME && read.symbol === WUSDT_SYMBOL;
    report.record(
      chain,
      "deployed wUSDT is Wrapped USDT with this chain's decimals",
      decimalsOk && identityOk,
      `${read.name} / ${read.symbol} / ${read.decimals} decimals at ${wusdt}`,
    );
    report.record(
      chain,
      "minter is the mint engine's key",
      custodyAddress !== "" && read.minter.toLowerCase() === custodyAddress.toLowerCase(),
      `minter ${read.minter}${custodyAddress ? ` (expected ${custodyAddress})` : ""}`,
    );
    report.record(
      chain,
      "governor is the launch governance address",
      read.governor.toLowerCase() === expectedGovernor,
      `governor ${read.governor}`,
    );
    supplyRaw = read.totalSupply;
    report.note(chain, "wUSDT contract", tokenLink(chain, wusdt));
  } catch (err) {
    report.fail(chain, "deployed wUSDT readable", `${wusdt}: ${shortError(err)}`);
    continue;
  }

  // ── the swap path ─────────────────────────────────────────────────────────
  const router = swapRouter(chain);
  if (!router) {
    report.fail(chain, `SWAP_ROUTER_${chain.toUpperCase()} set`, "not set — the Gate 4 swap and liquidation steps would abort");
  } else {
    try {
      report.record(chain, "DEX router has code", await codePresent(p, router), `${router} (${swapDexName(chain)})`);
    } catch (err) {
      report.fail(chain, "DEX router readable", shortError(err));
    }
  }

  // ── custody gas + the reserve invariant ───────────────────────────────────
  if (custodyAddress) {
    try {
      const gas = await nativeBalance(p, custodyAddress);
      report.record(chain, "custody account holds gas", gas > 0n, `${human(gas, 18)} native — ${custodyAddress}`);
    } catch (err) {
      report.fail(chain, "custody gas balance readable", shortError(err));
    }

    try {
      const custodied = await tokenBalance(p, usdt, custodyAddress);
      report.record(
        chain,
        "supply does not exceed the custodied USDT",
        custodied >= supplyRaw,
        `custody ${human(custodied, expectedUsdtDecimals)} USDT · supply ${human(supplyRaw, expectedUsdtDecimals)} wUSDT`,
      );
    } catch (err) {
      report.fail(chain, "custodied USDT readable", shortError(err));
    }
  }
}

report.finish({ chains, custodyAddress });
