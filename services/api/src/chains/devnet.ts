import { Contract, ContractFactory } from "ethers";
import { config } from "../config";
import { prisma } from "../db";
import { CHAIN_REGISTRY, toRaw, type ChainName } from "../shared";
import { compileContracts, type CompiledContract } from "./compiler";
import { providerFor, ROLE, signerFor, waitForRpc } from "./rpc";
import { ensureWalletRows } from "./wallets";

/**
 * Bring every configured chain to a usable state.
 *
 * devnet: each chain is a local Anvil node. The platform compiles contracts from
 * the checkout, deploys the fleet if it is missing (idempotent — a redeploy only
 * happens when the node lost its state), wires the minter role to the treasury
 * vault, and funds the devnet-only balances: custody USDT (the stand-in for an
 * attested real-USDT lock) and DEX reserves.
 *
 * live: nothing is deployed here. Addresses come from the environment, USDT is
 * Tether's own contract and swaps route through the chain's real DEX.
 *
 * A chain that cannot be reached is reported as unavailable instead of taking
 * the whole platform down — the console shows it as awaiting RPC.
 */
export async function bootstrapChains(): Promise<void> {
  for (const chain of config.chainTargets) {
    try {
      if (config.chainMode === "devnet") await bootstrapDevnetChain(chain);
      else await bootstrapLiveChain(chain);
      await ensureWalletRows(chain);
      console.log(`[chain] ${chain}: ready (${config.chainMode})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chain] ${chain}: unavailable — ${message.slice(0, 300)}`);
    }
  }
}

async function deployContract(contract: CompiledContract, signer: ReturnType<typeof signerFor>, args: unknown[]) {
  const factory = new ContractFactory(contract.abi as any, contract.bytecode, signer as any);
  const deployed = await factory.deploy(...args);
  await deployed.waitForDeployment();
  return deployed.getAddress();
}

async function bootstrapDevnetChain(chain: ChainName) {
  await waitForRpc(chain);
  const registry = CHAIN_REGISTRY[chain];
  const decimals = registry.usdtDecimals;
  const provider = providerFor(chain);

  const existing = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (existing && existing.mode === "devnet") {
    const code = await provider.getCode(existing.wusdt);
    if (code && code !== "0x") return existing; // fleet still deployed, nothing to do
  }

  const bundle = compileContracts();
  const governor = signerFor(chain, ROLE.governance);
  const treasury = signerFor(chain, ROLE.treasuryVault);

  const usdt = await deployContract(bundle.MockUSDT, governor, [decimals]);
  const wusdt = await deployContract(bundle.WrappedUSDT, governor, [
    "Wrapped USDT",
    "wUSDT",
    decimals,
    governor.address,
  ]);
  const dexRouter = await deployContract(bundle.LocalDexRouter, governor, [wusdt, usdt]);

  // Mint engine custody: the treasury vault signer is the only minter.
  const wusdtContract = new Contract(wusdt, bundle.WrappedUSDT.abi as any, governor as any) as any;
  await (await wusdtContract.setMinter(treasury.address)).wait();

  // Devnet funding — the two balances that back everything else:
  //  · custody USDT held for the treasury vault (attested-lock stand-in)
  //  · USDT reserves inside the local DEX router, so swaps can really pay out
  const usdtContract = new Contract(usdt, bundle.MockUSDT.abi as any, governor as any) as any;
  await (await usdtContract.mint(treasury.address, toRaw(config.treasuryVaultTargetUsd, decimals))).wait();
  await (await usdtContract.mint(dexRouter, toRaw(config.treasuryVaultTargetUsd, decimals))).wait();

  return prisma.chainDeployment.upsert({
    where: { chain },
    update: {
      mode: "devnet",
      rpcUrl: config.rpcUrls[chain],
      explorerBase: null, // a local chain has no public explorer to link to
      usdt,
      usdtDecimals: decimals,
      wusdt,
      wusdtDecimals: decimals,
      dexRouter,
      dexName: "local-dex (devnet stand-in)",
      governor: governor.address,
    },
    create: {
      chain,
      chainId: registry.chainId,
      mode: "devnet",
      rpcUrl: config.rpcUrls[chain],
      explorerBase: null,
      usdt,
      usdtDecimals: decimals,
      wusdt,
      wusdtDecimals: decimals,
      dexRouter,
      dexName: "local-dex (devnet stand-in)",
      governor: governor.address,
    },
  });
}

async function bootstrapLiveChain(chain: ChainName) {
  const registry = CHAIN_REGISTRY[chain];
  const key = `WUSDT_${chain.toUpperCase()}`;
  const wusdt = process.env[key];
  if (!wusdt) throw new Error(`${key} must be set in live mode`);

  const treasury = signerFor(chain, ROLE.treasuryVault);
  const dexRouter = process.env[`SWAP_ROUTER_${chain.toUpperCase()}`] ?? "";

  return prisma.chainDeployment.upsert({
    where: { chain },
    update: {
      mode: "live",
      rpcUrl: config.rpcUrls[chain],
      explorerBase: registry.explorerBase,
      usdt: registry.usdt,
      usdtDecimals: registry.usdtDecimals,
      wusdt,
      wusdtDecimals: registry.usdtDecimals,
      dexRouter,
      dexName: process.env[`SWAP_DEX_${chain.toUpperCase()}`] ?? "dex",
      governor: treasury.address,
    },
    create: {
      chain,
      chainId: registry.chainId,
      mode: "live",
      rpcUrl: config.rpcUrls[chain],
      explorerBase: registry.explorerBase,
      usdt: registry.usdt,
      usdtDecimals: registry.usdtDecimals,
      wusdt,
      wusdtDecimals: registry.usdtDecimals,
      dexRouter,
      dexName: process.env[`SWAP_DEX_${chain.toUpperCase()}`] ?? "dex",
      governor: treasury.address,
    },
  });
}
