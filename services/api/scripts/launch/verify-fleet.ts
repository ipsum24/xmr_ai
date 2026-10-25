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
 *   · its minter is the TreasuryVault — never an EOA — and that vault is bound to
 *     this token, sized for this chain and capped at the launch target
 *   · the custody signer holds the vault's BRIDGE_ROLE and OPERATOR_ROLE (inject,
 *     distribute, release) and the vault's shadow ledger reconciles (drift 0)
 *   · governor is the launch multisig, and the vault is not paused
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
  reserveTargetUsd,
  rpcEnvName,
  rpcUrl,
  shortError,
  swapDexName,
  swapRouter,
  targetChains,
  usdtAddress,
  usdtDecimals,
  vaultAddress,
  wusdtAddress,
} from "./lib/env";
import {
  addressForKey,
  chainIdOf,
  codePresent,
  nativeBalance,
  provider,
  readToken,
  readVault,
  readWusdt,
  tokenBalance,
  vaultHasRole,
} from "./lib/fleet";
import { toRaw, tokenLink } from "../../src/shared";

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
  let minter = "";
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
      "governor is the launch governance address",
      read.governor.toLowerCase() === expectedGovernor,
      `governor ${read.governor}`,
    );
    supplyRaw = read.totalSupply;
    minter = read.minter;
    report.note(chain, "wUSDT contract", tokenLink(chain, wusdt));
  } catch (err) {
    report.fail(chain, "deployed wUSDT readable", `${wusdt}: ${shortError(err)}`);
    continue;
  }

  // ── the TreasuryVault: the only address that may create supply ────────────
  const vault = vaultAddress(chain);
  if (!vault) {
    report.fail(
      chain,
      `TREASURY_VAULT_${chain.toUpperCase()} set`,
      "not set — Gate 1 deploys it; without it the reserve model is not wired (no vault can inject, distribute or release)",
    );
  } else {
    try {
      const read = await readVault(p, vault);
      const reserveTargetRaw = toRaw(reserveTargetUsd(), expectedUsdtDecimals);

      report.record(
        chain,
        "wUSDT's minter is the TreasuryVault (no key can mint supply)",
        minter.toLowerCase() === vault.toLowerCase(),
        `minter ${minter} · vault ${vault}`,
      );
      report.record(
        chain,
        "the vault is bound to this wUSDT",
        read.wusdt.toLowerCase() === wusdt.toLowerCase(),
        `vault.wUSDT ${read.wusdt}`,
      );
      report.record(
        chain,
        "the vault's decimals match this chain's USDT",
        read.decimals === expectedUsdtDecimals,
        `${read.decimals} decimals (registry: ${expectedUsdtDecimals})`,
      );
      report.record(
        chain,
        "the vault's reserve ceiling is the launch target",
        read.maxReserveRaw === BigInt(reserveTargetRaw),
        `maxReserve ${human(read.maxReserveRaw, expectedUsdtDecimals)} wUSDT (target ${reserveTargetUsd().toLocaleString("en-US")})`,
      );
      report.record(
        chain,
        "the vault's governor is the launch governance address",
        read.governor.toLowerCase() === expectedGovernor,
        `governor ${read.governor}`,
      );
      report.record(
        chain,
        "the vault's shadow ledger reconciles with the tokens it holds",
        read.driftRaw === 0n,
        `reserve ${human(read.reserveRaw, expectedUsdtDecimals)} wUSDT · released ${read.redemptionReleasedRaw} · drift ${read.driftRaw} · utilization ${read.utilizationBps} bps`,
      );
      report.record(
        chain,
        "the vault is not paused",
        !read.paused,
        read.paused ? "PAUSED — minting, distribution and transfers are stopped" : "active",
      );
      report.note(chain, "TreasuryVault contract", tokenLink(chain, vault));

      if (custodyAddress) {
        report.record(
          chain,
          "custody holds BRIDGE_ROLE (it injects the mint cycles)",
          await vaultHasRole(p, vault, "BRIDGE_ROLE", custodyAddress),
          custodyAddress,
        );
        report.record(
          chain,
          "custody holds OPERATOR_ROLE (it distributes and releases)",
          await vaultHasRole(p, vault, "OPERATOR_ROLE", custodyAddress),
          custodyAddress,
        );
      }
    } catch (err) {
      report.fail(chain, "TreasuryVault readable", `${vault}: ${shortError(err)}`);
    }
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
