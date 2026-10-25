/**
 * GATE 1 — deploy the reserve fleet per chain (wUSDT + its TreasuryVault).
 *
 * Compiles both contracts from THIS checkout's own source and deploys them on
 * each target mainnet with Tether's real USDT decimals for that chain, then wires
 * the reserve model:
 *
 *   · the TreasuryVault is wUSDT's ONLY minter (`setMinter(vault)`), so supply can
 *     never appear from a signature — the vault mints only against a
 *     replay-protected bridge message;
 *   · the custody signer holds the vault's `BRIDGE_ROLE` (inject a mint cycle)
 *     and `OPERATOR_ROLE` (distribute the 25 %, release a payout, confirm a
 *     redemption);
 *   · when `LAUNCH_GOVERNOR` names a multisig, governance of BOTH contracts is
 *     handed over, so the deploy key keeps no authority.
 *
 * Sequential by design: one chain at a time, each verified by reading the fleet
 * back before the next one starts.
 *
 *   docker compose exec -T api npx tsx services/api/scripts/launch/deploy-fleet.ts
 *   … --chains=ethereum,bsc
 *
 * The addresses this prints are the `WUSDT_<CHAIN>` and `TREASURY_VAULT_<CHAIN>`
 * values live mode reads.
 */
import type { JsonRpcProvider } from "ethers";
import {
  custodyKey,
  explorerTxUrl,
  finalGovernor,
  GateReport,
  banner,
  label,
  registryChainId,
  rpcEnvName,
  rpcUrl,
  shortError,
  targetChains,
  usdtDecimals,
  vaultAddress,
  wusdtAddress,
} from "./lib/env";
import {
  addressForKey,
  chainIdOf,
  codePresent,
  deployFleet,
  provider,
  readVault,
  readWusdt,
  vaultHasRole,
} from "./lib/fleet";

const chains = targetChains();
const report = new GateReport("gate1-deploy-fleet");
const deployed: Record<string, { wusdt: string; vault: string }> = {};

banner("GATE 1 — deploy the reserve fleet (wUSDT + TreasuryVault)", [
  `chains: ${chains.join(", ")}`,
  "this gate broadcasts REAL deployment transactions, one chain at a time",
]);

const key = custodyKey();
if (!key) {
  report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY set", "not set — nothing can be deployed");
  report.finish({ chains, deployed });
}
const custodyAddress = addressForKey(key);
const governorToHandOverTo = finalGovernor();
const expectedGovernor = (governorToHandOverTo || custodyAddress).toLowerCase();
console.log(`deploy key / governor: ${custodyAddress}`);
console.log(`custody (bridge + operator): ${custodyAddress}`);
if (governorToHandOverTo) console.log(`governance hand-over:  ${governorToHandOverTo}`);

/**
 * Is the fleet the environment names already deployed AND wired? A half-wired
 * fleet is never silently redeployed — the addresses would have to be unset, and
 * a second wUSDT on the same chain is exactly what a launch must not create.
 */
async function existingFleet(chain: (typeof chains)[number], p: JsonRpcProvider): Promise<boolean> {
  const wusdt = wusdtAddress(chain);
  const vault = vaultAddress(chain);

  if (!wusdt || !vault) {
    report.fail(
      chain,
      `WUSDT_${chain.toUpperCase()} and TREASURY_VAULT_${chain.toUpperCase()} must be set together`,
      `${wusdt ? "WUSDT" : "TREASURY_VAULT"} is missing — this gate prints both lines; unset the one that is set to deploy a fresh fleet`,
    );
    return true; // handled: this chain is not deployed again
  }

  if (!(await codePresent(p, wusdt))) {
    report.fail(chain, "WUSDT_ env address has code", `${wusdt} is empty — unset it to deploy a fresh fleet`);
    return true;
  }
  if (!(await codePresent(p, vault))) {
    report.fail(chain, "TREASURY_VAULT_ env address has code", `${vault} is empty — unset it to deploy a fresh fleet`);
    return true;
  }

  const expectedDecimals = usdtDecimals(chain);
  const token = await readWusdt(p, wusdt);
  const read = await readVault(p, vault);
  const bridge = await vaultHasRole(p, vault, "BRIDGE_ROLE", custodyAddress);
  const operator = await vaultHasRole(p, vault, "OPERATOR_ROLE", custodyAddress);

  const problems = [
    token.decimals !== expectedDecimals ? `wUSDT has ${token.decimals} decimals, this chain needs ${expectedDecimals}` : "",
    token.minter.toLowerCase() !== vault.toLowerCase() ? `wUSDT minter is ${token.minter}, not the TreasuryVault ${vault}` : "",
    read.wusdt.toLowerCase() !== wusdt.toLowerCase() ? `vault ${vault} is bound to wUSDT ${read.wusdt}` : "",
    read.decimals !== expectedDecimals ? `vault has ${read.decimals} decimals, this chain needs ${expectedDecimals}` : "",
    token.governor.toLowerCase() !== expectedGovernor ? `wUSDT governor is ${token.governor}` : "",
    read.governor.toLowerCase() !== expectedGovernor ? `vault governor is ${read.governor}` : "",
    !bridge ? "custody lacks the vault's BRIDGE_ROLE" : "",
    !operator ? "custody lacks the vault's OPERATOR_ROLE" : "",
  ].filter(Boolean);

  if (problems.length > 0) {
    report.fail(chain, "already-deployed fleet is wired for the reserve model", `${wusdt} / ${vault}: ${problems.join("; ")}`);
    return true;
  }

  deployed[chain] = { wusdt, vault };
  report.record(chain, "fleet already deployed and wired", true, `wUSDT ${wusdt} · vault ${vault}`);
  return true;
}

async function deployOn(chain: (typeof chains)[number], p: JsonRpcProvider): Promise<void> {
  const expectedDecimals = usdtDecimals(chain);

  if (wusdtAddress(chain) || vaultAddress(chain)) {
    await existingFleet(chain, p);
    return;
  }

  const result = await deployFleet({
    provider: p,
    privateKey: key,
    decimals: expectedDecimals,
    operator: custodyAddress,
    handOffGovernorTo: governorToHandOverTo || undefined,
  });

  const token = await readWusdt(p, result.address);
  const read = await readVault(p, result.vault);
  const bridge = await vaultHasRole(p, result.vault, "BRIDGE_ROLE", custodyAddress);
  const operator = await vaultHasRole(p, result.vault, "OPERATOR_ROLE", custodyAddress);

  const ok =
    token.decimals === expectedDecimals &&
    token.minter.toLowerCase() === result.vault.toLowerCase() &&
    read.wusdt.toLowerCase() === result.address.toLowerCase() &&
    read.decimals === expectedDecimals &&
    token.governor.toLowerCase() === expectedGovernor &&
    read.governor.toLowerCase() === expectedGovernor &&
    bridge &&
    operator;

  report.record(
    chain,
    "deployed fleet reads back correctly and is wired",
    ok,
    `wUSDT ${result.address} (${token.symbol}, ${token.decimals} decimals, minter ${token.minter}) · ` +
      `vault ${result.vault} (bridge ${bridge ? "✓" : "✗"}, operator ${operator ? "✓" : "✗"}, governor ${read.governor})`,
  );
  if (!ok) return;

  report.note(chain, "wUSDT deploy tx", explorerTxUrl(chain, result.deployTxHash));
  report.note(chain, "TreasuryVault deploy tx", explorerTxUrl(chain, result.vaultDeployTxHash));
  report.note(chain, "setMinter(vault) tx", explorerTxUrl(chain, result.setMinterTxHash));
  report.note(chain, "grantRole(BRIDGE_ROLE) tx", explorerTxUrl(chain, result.grantBridgeTxHash));
  report.note(chain, "grantRole(OPERATOR_ROLE) tx", explorerTxUrl(chain, result.grantOperatorTxHash));
  if (result.setGovernorTxHash) report.note(chain, "wUSDT setGovernor tx", explorerTxUrl(chain, result.setGovernorTxHash));
  if (result.vaultSetGovernorTxHash) report.note(chain, "vault setGovernor tx", explorerTxUrl(chain, result.vaultSetGovernorTxHash));

  deployed[chain] = { wusdt: result.address, vault: result.vault };
}

for (const chain of chains) {
  const rpc = rpcUrl(chain);
  if (!rpc) {
    report.fail(chain, `${rpcEnvName(chain)} set`, "not set — nothing to deploy onto");
    continue;
  }

  try {
    const p = provider(rpc);
    const actualChainId = await chainIdOf(p);
    if (!report.record(chain, `RPC is ${label(chain)} (chain id ${registryChainId(chain)})`, actualChainId === registryChainId(chain), `chain id ${actualChainId}`)) {
      continue; // never deploy onto a chain we failed to identify
    }
    await deployOn(chain, p);
  } catch (err) {
    report.fail(chain, "deploy", shortError(err));
  }
}

if (Object.keys(deployed).length > 0) {
  console.log("\nAdd these to the live environment, then run Gate 2 (verify):");
  for (const [chain, fleet] of Object.entries(deployed)) {
    console.log(`  WUSDT_${chain.toUpperCase()}=${fleet.wusdt}`);
    console.log(`  TREASURY_VAULT_${chain.toUpperCase()}=${fleet.vault}`);
  }
  console.log("\nThe vault is wUSDT's only minter: the custody key can inject, distribute and release, never mint.");
}

report.finish({ chains, deployed });
