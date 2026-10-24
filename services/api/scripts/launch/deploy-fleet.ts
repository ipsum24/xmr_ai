/**
 * GATE 1 — deploy the wUSDT contract per chain.
 *
 * Compiles WrappedUSDT from this checkout's own source and deploys it on each
 * target mainnet with Tether's real USDT decimals for that chain, then hands the
 * minter role to the mint engine's signer (the same custody key the API signs
 * with). Launch GOVERNANCE is handed to a multisig when LAUNCH_GOVERNOR is set,
 * so the deploy key keeps no authority afterwards.
 *
 * Sequential by design: one chain at a time, each verified by reading the
 * contract back before the next one starts.
 *
 *   docker compose exec -T api npx tsx services/api/scripts/launch/deploy-fleet.ts
 *   … --chains=ethereum,bsc
 *
 * The addresses this prints are the `WUSDT_<CHAIN>` values live mode reads.
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
  wusdtAddress,
} from "./lib/env";
import { addressForKey, chainIdOf, codePresent, deployWusdt, provider, readWusdt } from "./lib/fleet";

const chains = targetChains();
const report = new GateReport("gate1-deploy-fleet");
const deployed: Record<string, string> = {};

banner("GATE 1 — deploy wUSDT fleet", [
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
console.log(`deploy key: ${custodyAddress}`);
console.log(`minter:     ${custodyAddress} (the mint engine signs with this key)`);
if (governorToHandOverTo) console.log(`governance hand-over: ${governorToHandOverTo}`);

async function deployOn(chain: (typeof chains)[number], p: JsonRpcProvider): Promise<void> {
  const existing = wusdtAddress(chain);
  const expectedDecimals = usdtDecimals(chain);

  if (existing) {
    if (!(await codePresent(p, existing))) {
      report.fail(chain, "WUSDT_ env address has code", `${existing} is empty — unset it to deploy a fresh contract`);
      return;
    }
    const read = await readWusdt(p, existing);
    if (read.decimals !== expectedDecimals) {
      report.fail(
        chain,
        "already-deployed wUSDT decimals match the chain",
        `${existing} has ${read.decimals} decimals, this chain needs ${expectedDecimals} — deploy a new contract`,
      );
      return;
    }
    if (read.minter.toLowerCase() !== custodyAddress.toLowerCase()) {
      report.fail(
        chain,
        "already-deployed wUSDT minter is the mint engine key",
        `minter is ${read.minter}; the governor must call setMinter(${custodyAddress}) on ${existing}`,
      );
      return;
    }
    deployed[chain] = existing;
    report.record(chain, "wUSDT already deployed and usable", true, `${existing} (${read.symbol}, ${read.decimals} decimals)`);
    return;
  }

  const result = await deployWusdt({
    provider: p,
    privateKey: key,
    decimals: expectedDecimals,
    governor: custodyAddress,
    minter: custodyAddress,
    handOffGovernorTo: governorToHandOverTo || undefined,
  });

  const read = await readWusdt(p, result.address);
  const ok =
    read.decimals === expectedDecimals &&
    read.minter.toLowerCase() === custodyAddress.toLowerCase() &&
    (governorToHandOverTo
      ? read.governor.toLowerCase() === governorToHandOverTo.toLowerCase()
      : read.governor.toLowerCase() === custodyAddress.toLowerCase());

  report.record(
    chain,
    "deployed wUSDT reads back correctly",
    ok,
    `${result.address} — ${read.symbol}, ${read.decimals} decimals, minter ${read.minter}, governor ${read.governor}`,
  );
  report.note(chain, "deploy tx", explorerTxUrl(chain, result.deployTxHash));
  report.note(chain, "setMinter tx", explorerTxUrl(chain, result.setMinterTxHash));
  if (result.setGovernorTxHash) report.note(chain, "setGovernor tx", explorerTxUrl(chain, result.setGovernorTxHash));

  if (ok) deployed[chain] = result.address;
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
  for (const [chain, address] of Object.entries(deployed)) {
    console.log(`  WUSDT_${chain.toUpperCase()}=${address}`);
  }
}

report.finish({ chains, deployed });
