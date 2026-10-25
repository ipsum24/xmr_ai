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
    if (code && code !== "0x") {
      if (await hasReserveModel(chain, existing.wusdt)) {
        // Same generation of contracts: complete the vault wiring in place.
        const vault = await ensureVault(chain, existing.wusdt, decimals);
        if (vault === existing.vault) return existing;
        return prisma.chainDeployment.update({ where: { chain }, data: { vault } });
      }
      console.warn(`[chain] ${chain}: the deployed wUSDT predates the reserve model — deploying a fresh devnet fleet`);
    }
  }

  // A fresh fleet means the mint-cycle rows below describe a chain state that no
  // longer exists, so the startup cycle has to run again against the new fleet.
  await prisma.mintCycle.deleteMany({ where: { chain } });

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

  // Reserve model: the TreasuryVault is wUSDT's only minter and holds the shadow
  // ledger; the custody signer holds the bridge/operator roles it signs with.
  const vault = await ensureVault(chain, wusdt, decimals, bundle);

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
      vault,
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
      vault,
      dexRouter,
      dexName: "local-dex (devnet stand-in)",
      governor: governor.address,
    },
  });
}

/**
 * Does the deployed token carry the reserve model (role-separated minting plus
 * replay-safe redemption ids)? Only the enhanced contract answers this call, so a
 * fleet deployed from an earlier revision is detected instead of half-used.
 */
async function hasReserveModel(chain: ChainName, wusdtAddress: string): Promise<boolean> {
  const token = new Contract(
    wusdtAddress,
    ["function redemptionNonce() view returns (uint256)"] as unknown as string[],
    providerFor(chain),
  ) as any;
  try {
    await token.redemptionNonce();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring the TreasuryVault up on a chain and wire the reserve roles.
 *
 * The vault has to be the token's minter — that is what makes the shadow ledger
 * the only source of supply — and the custody signer needs BRIDGE_ROLE to inject
 * a cycle plus OPERATOR_ROLE to distribute and release. Idempotent: a vault that
 * is already deployed and wired is left untouched.
 */
async function ensureVault(chain: ChainName, wusdtAddress: string, decimals: number, bundle = compileContracts()): Promise<string> {
  const provider = providerFor(chain);
  const governor = signerFor(chain, ROLE.governance);
  const custody = signerFor(chain, ROLE.treasuryVault);
  const wusdt = new Contract(wusdtAddress, bundle.WrappedUSDT.abi as any, governor as any) as any;

  const row = await prisma.chainDeployment.findUnique({ where: { chain } });
  let vault = row?.vault ?? "";
  if (vault) {
    const code = await provider.getCode(vault);
    // A vault is bound to one token at construction: reusing it after the token
    // was redeployed would leave the reserve minting the previous wUSDT.
    const wired = code && code !== "0x"
      ? ((await (new Contract(vault, bundle.TreasuryVault.abi as any, provider) as any).wUSDT()) as string)
      : "";
    if (wired.toLowerCase() !== wusdtAddress.toLowerCase()) vault = "";
  }
  if (!vault) {
    vault = await deployContract(bundle.TreasuryVault, governor, [wusdtAddress, governor.address, decimals]);
    console.log(`[chain] ${chain}: TreasuryVault deployed at ${vault}`);
  }

  const vaultContract = new Contract(vault, bundle.TreasuryVault.abi as any, governor as any) as any;
  const minter: string = await wusdt.minter();
  if (minter.toLowerCase() !== vault.toLowerCase()) {
    await (await wusdt.setMinter(vault)).wait();
    console.log(`[chain] ${chain}: wUSDT minter set to the TreasuryVault`);
  }

  const roleGrants: [string, string][] = [
    [await vaultContract.BRIDGE_ROLE(), custody.address],
    [await vaultContract.OPERATOR_ROLE(), custody.address],
  ];
  for (const [role, account] of roleGrants) {
    if (!(await vaultContract.hasRole(role, account))) {
      await (await vaultContract.grantRole(role, account)).wait();
    }
  }

  // Sandbox ceiling: a local chain has no real money to protect, and the console's
  // refill cycles need headroom above the $10M default a live launch starts with.
  const devnetCeiling = 100_000_000n * 10n ** BigInt(decimals);
  if ((await vaultContract.maxReserve()) < devnetCeiling) {
    await (await vaultContract.setMaxReserve(devnetCeiling)).wait();
  }

  return vault;
}

async function bootstrapLiveChain(chain: ChainName) {
  const registry = CHAIN_REGISTRY[chain];
  const key = `WUSDT_${chain.toUpperCase()}`;
  const wusdt = process.env[key];
  if (!wusdt) throw new Error(`${key} must be set in live mode`);

  const treasury = signerFor(chain, ROLE.treasuryVault);
  const dexRouter = process.env[`SWAP_ROUTER_${chain.toUpperCase()}`] ?? "";
  // Gate 1 prints this: the vault is wUSDT's only minter and holds the reserve.
  const vault = process.env[`TREASURY_VAULT_${chain.toUpperCase()}`] ?? "";
  if (!vault) {
    console.warn(`[chain] ${chain}: TREASURY_VAULT_${chain.toUpperCase()} is not set — the reserve model needs it (run Gate 1)`);
  }

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
      vault,
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
      vault,
      dexRouter,
      dexName: process.env[`SWAP_DEX_${chain.toUpperCase()}`] ?? "dex",
      governor: treasury.address,
    },
  });
}
