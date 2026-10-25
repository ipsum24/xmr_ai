import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import { getAddress, id, Interface, isHexString, ZeroAddress } from "ethers";
import { CHAIN_REGISTRY, CONFIRMATIONS, type ChainName } from "../../src/shared";
import { targetChains } from "./lib/env";
import { compileVault, compileWusdt, VAULT_ABI, WUSDT_ABI, WUSDT_NAME, WUSDT_SYMBOL } from "./lib/fleet";
import { assertLaunchMode, LaunchError, safeFailure, SecretsResolver } from "./lib/secrets-resolver";
import { KmsSigner } from "./lib/kms-signer";
import { DeploymentJournal, sha256 } from "./lib/deployment-journal";
import { assertFee, positiveInteger, probeNetwork, resolveEndpoints, type DeploymentNetwork } from "./lib/deployment-network";
import { DeploymentSteps, type Create2Config } from "./lib/deployment-steps";
import { assertDeployedEffects } from "./lib/deployed-effects";
import { verifyContract } from "./lib/verify-contract";

const address = (value: string, name: string): string => {
  try {
    const result = getAddress(value);
    if (result === ZeroAddress) throw new Error("zero");
    return result;
  } catch { throw new LaunchError(`${name} must be a nonzero EVM address`); }
};

async function main(): Promise<void> {
  assertLaunchMode();
  const chains = [...new Set(targetChains())];
  const checkOnly = process.argv.includes("--check");
  const resolver = new SecretsResolver();
  const kms = new KMSClient({ region: process.env.AWS_REGION, maxAttempts: 2 });
  let journal: DeploymentJournal | undefined;
  const networks: DeploymentNetwork[] = [];
  try {
    const signer = new KmsSigner(await resolver.require("LIVE_SIGNER_KEY_ID"), kms);
    const deployer = await signer.getAddress();
    const governor = address(await resolver.get("LAUNCH_GOVERNOR") || deployer, "LAUNCH_GOVERNOR");
    const operator = address(await resolver.require("LAUNCH_OPERATOR"), "LAUNCH_OPERATOR");
    const bridge = address(await resolver.get("LAUNCH_BRIDGE") || operator, "LAUNCH_BRIDGE");
    const gasBudget = BigInt(positiveInteger(process.env.DEPLOY_GAS_BUDGET ?? "", 15_000_000));
    const timeout = positiveInteger(process.env.DEPLOY_CONFIRM_TIMEOUT_MS ?? "", 300_000);
    const feeCeiling = process.env.DEPLOY_MAX_FEE_GWEI;
    const salt = await resolver.get("FLEET_SALT");
    if (salt && !isHexString(salt, 32)) throw new LaunchError("FLEET_SALT must be a bytes32 hex value");
    const tokenArtifact = compileWusdt();
    const vaultArtifact = compileVault();
    const configuration = await Promise.all(chains.map(async (chain) => {
      const suffix = chain.toUpperCase();
      const token = await resolver.get(`WUSDT_${suffix}`);
      const vault = await resolver.get(`TREASURY_VAULT_${suffix}`);
      if (Boolean(token) !== Boolean(vault)) throw new LaunchError(`${chain}: supply both existing fleet addresses or neither`);
      let create2: Create2Config | undefined;
      if (salt) {
        const factory = await resolver.require(`CREATE2_FACTORY_${suffix}`);
        const codeHash = await resolver.require("CREATE2_FACTORY_CODE_HASH");
        if (!isHexString(codeHash, 32)) throw new LaunchError("CREATE2_FACTORY_CODE_HASH must be bytes32");
        create2 = { address: address(factory, `CREATE2_FACTORY_${suffix}`), codeHash, salt };
      }
      return {
        chain, urls: await resolveEndpoints(chain, resolver), create2,
        existing: token ? { wusdt: address(token, `WUSDT_${suffix}`), vault: address(vault, `TREASURY_VAULT_${suffix}`) } : undefined,
      };
    }));
    // Fingerprint contains no RPC credentials, KMS key IDs, API keys or raw keys.
    const fingerprint = sha256(JSON.stringify({
      source: [sha256(tokenArtifact.bytecode), sha256(vaultArtifact.bytecode)], deployer, governor, operator, bridge,
      chains: configuration.map(({ chain, create2 }) => ({ chain, create2 })),
    }));
    const directory = path.resolve(process.env.DEPLOY_RECEIPT_DIR || fileURLToPath(new URL("../../../../reports/deploy/", import.meta.url)));
    journal = new DeploymentJournal(directory, fingerprint);
    const store = journal;
    console.log(`Deployment ${checkOnly ? "preflight (read-only)" : "sequence"}: ${chains.join(", ")}; signer ${deployer}`);

    // Resolve and validate ALL chains before any chain is allowed to broadcast.
    const preflight = await Promise.allSettled(configuration.map(async (cfg) => {
      const network = await probeNetwork(cfg.chain, cfg.urls, deployer, gasBudget);
      networks.push(network);
      assertFee(network.fee, network.fee, feeCeiling);
      if (governor !== deployer && await network.provider.getCode(governor) === "0x") throw new LaunchError(`${cfg.chain}: governance address is not a deployed multisig/contract`);
      return { ...cfg, network };
    }));
    const preflightFailures = preflight.flatMap((item, index) => item.status === "rejected" ? [{ chain: configuration[index].chain, error: safeFailure(item.reason) }] : []);
    if (preflightFailures.length) {
      store.receipt([], preflightFailures);
      for (const failure of preflightFailures) console.error(`${failure.chain}: ${failure.error}`);
      throw new LaunchError("Preflight failed; no deployment transactions were sent");
    }
    if (checkOnly) {
      console.log("All selected chains passed live identity, head freshness, official USDT and gas-budget checks; no transactions sent.");
      return;
    }

    const ready = preflight.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const settlements = await Promise.allSettled(ready.map(async ({ chain, network, create2, existing }) => {
      const record = store.chain(chain);
      const steps = new DeploymentSteps(network, signer.connect(network.provider), store, CONFIRMATIONS[chain], timeout, feeCeiling);
      const decimals = CHAIN_REGISTRY[chain].usdtDecimals;
      if (existing && ((record.wusdt && record.wusdt.toLowerCase() !== existing.wusdt.toLowerCase()) ||
        (record.vault && record.vault.toLowerCase() !== existing.vault.toLowerCase()))) {
        throw new LaunchError(`${chain}: configured fleet conflicts with the durable journal`);
      }
      // A partially wired journal must resume its steps even if outputs were saved
      // into the environment after the first attempt.
      let fleet = Object.keys(record.steps).length ? undefined : existing;
      if (!fleet) {
        const wusdt = await steps.deploy("deploy-wusdt", tokenArtifact, [WUSDT_NAME, WUSDT_SYMBOL, decimals, deployer], create2);
        record.wusdt = wusdt;
        store.save();
        const vault = await steps.deploy("deploy-vault", vaultArtifact, [wusdt, deployer, decimals], create2);
        record.vault = vault;
        store.save();
        const tokenInterface = new Interface(WUSDT_ABI);
        const vaultInterface = new Interface(VAULT_ABI);
        await steps.transaction("set-minter", { to: wusdt, data: tokenInterface.encodeFunctionData("setMinter", [vault]) });
        await steps.transaction("grant-bridge", { to: vault, data: vaultInterface.encodeFunctionData("grantRole", [id("BRIDGE_ROLE"), bridge]) });
        await steps.transaction("grant-operator", { to: vault, data: vaultInterface.encodeFunctionData("grantRole", [id("OPERATOR_ROLE"), operator]) });
        if (governor !== deployer) {
          await steps.transaction("handover-wusdt", { to: wusdt, data: tokenInterface.encodeFunctionData("setGovernor", [governor]) });
          await steps.transaction("handover-vault", { to: vault, data: vaultInterface.encodeFunctionData("setGovernor", [governor]) });
        }
        fleet = { wusdt, vault };
      }
      await assertDeployedEffects(network.provider, chain, { ...fleet, deployer, governor, bridge, operator }, Object.keys(record.steps).length > 0 && !record.verified);
      record.wusdt = fleet.wusdt;
      record.vault = fleet.vault;
      record.verified = true;
      store.save();
      const explorerKey = await resolver.get(`ETHERSCAN_V2_KEY_${chain.toUpperCase()}`).catch(() => "") || await resolver.get("ETHERSCAN_V2_KEY").catch(() => "");
      const explorer = await Promise.all([
        verifyContract({ chain, contract: "WrappedUSDT", address: fleet.wusdt, artifact: tokenArtifact, args: [WUSDT_NAME, WUSDT_SYMBOL, decimals, deployer], key: explorerKey }),
        verifyContract({ chain, contract: "TreasuryVault", address: fleet.vault, artifact: vaultArtifact, args: [fleet.wusdt, deployer, decimals], key: explorerKey }),
      ]);
      return { chain, ...fleet, onchainVerified: true, explorer, transactions: Object.fromEntries(Object.entries(record.steps).map(([name, step]) => [name, step.hash])) };
    }));
    const results = settlements.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const failures = settlements.flatMap((item, index) => item.status === "rejected" ? [{ chain: ready[index].chain, error: safeFailure(item.reason) }] : []);
    store.receipt(results, failures);
    for (const result of results) {
      console.log(`${result.chain}: on-chain invariants passed; explorer ${result.explorer.every((item) => item.ok) ? "verified" : "manual-queued"}`);
      console.log(`WUSDT_${result.chain.toUpperCase()}=${result.wusdt}`);
      console.log(`TREASURY_VAULT_${result.chain.toUpperCase()}=${result.vault}`);
    }
    for (const failure of failures) console.error(`${failure.chain}: ${failure.error}`);
    const alert = await resolver.get("DEPLOY_OPS_WEBHOOK_URL").catch(() => "");
    if (failures.length && alert) {
      try {
        const response = await fetch(alert, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "DEPLOY-FAILED", failures }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) console.error("Ops notification was not accepted");
      } catch { console.error("Ops notification could not be delivered"); }
    }
    if (failures.length) throw new LaunchError("Deployment is partial; retain the journal and rerun to resume without replacement deployments");
  } finally {
    for (const network of networks) network.provider.destroy();
    journal?.close();
    resolver.destroy();
    kms.destroy();
  }
}

main().catch((error: unknown) => { console.error(safeFailure(error)); process.exitCode = 1; });
