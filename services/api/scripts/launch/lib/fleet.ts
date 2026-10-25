/**
 * Fleet mechanics for the launch gates: compile wUSDT and its TreasuryVault from
 * THIS checkout's own Solidity source, deploy them wired to each other, and read
 * the wiring back from chain.
 *
 * The reserve model needs BOTH contracts: the vault holds wUSDT's minter role
 * (so no EOA can create supply) and mints only inside `injectNetReserve`. Gate 1
 * therefore deploys the pair and wires the roles — a token whose minter is a
 * plain address is exactly what the enhanced design forbids.
 *
 * Everything takes explicit parameters (RPC, key, decimals) instead of reading
 * the app config, so the gates stay usable on a machine where the app cannot
 * boot yet — and so the same mechanics can be exercised against a local chain
 * without touching the live path.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, type TransactionReceipt } from "ethers";
import solc from "solc";

const WUSDT_SOURCE_PATH = fileURLToPath(new URL("../../../../../contracts/src/WrappedUSDT.sol", import.meta.url));
const VAULT_SOURCE_PATH = fileURLToPath(new URL("../../../../../contracts/src/TreasuryVault.sol", import.meta.url));

export const WUSDT_NAME = "Wrapped USDT";
export const WUSDT_SYMBOL = "wUSDT";

/** wUSDT's own surface, plus the ERC-20 reads every gate needs. */
export const WUSDT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function governor() view returns (address)",
  "function minter() view returns (address)",
  "function setMinter(address)",
  "function setGovernor(address)",
] as const;

export const ERC20_VIEW_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
] as const;

/** The vault's surface the gates read and wire — plus the role constants. */
export const VAULT_ABI = [
  "function governor() view returns (address)",
  "function wUSDT() view returns (address)",
  "function decimals() view returns (uint8)",
  "function currentReserve() view returns (uint256)",
  "function maxReserve() view returns (uint256)",
  "function redemptionReleased() view returns (uint256)",
  "function reserveDrift() view returns (int256)",
  "function getUtilizationBps() view returns (uint256)",
  "function paused() view returns (bool)",
  "function ADMIN_ROLE() view returns (bytes32)",
  "function BRIDGE_ROLE() view returns (bytes32)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function revokeRole(bytes32,address)",
  "function setGovernor(address)",
  "function setMaxReserve(uint256)",
] as const;

export interface CompiledContract {
  abi: readonly unknown[];
  bytecode: string;
}

/** solc, straight from the repo sources — the bytecode the gates deploy. */
function compileSources(sources: Record<string, string>, file: string, contract: string): CompiledContract {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, { content }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(`solc failed:\n${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")}`);
  }

  const artifact = output.contracts?.[file]?.[contract];
  const bytecode = artifact?.evm?.bytecode?.object;
  if (!bytecode) throw new Error(`${contract} did not compile from ${file}`);

  return { abi: artifact.abi, bytecode: `0x${bytecode}` };
}

let compiledWusdt: CompiledContract | null = null;
let compiledVault: CompiledContract | null = null;

export function compileWusdt(): CompiledContract {
  compiledWusdt ??= compileSources(
    { "WrappedUSDT.sol": fs.readFileSync(WUSDT_SOURCE_PATH, "utf8") },
    "WrappedUSDT.sol",
    "WrappedUSDT",
  );
  return compiledWusdt;
}

/**
 * The vault compiles together with the token: `TreasuryVault.sol` imports
 * `./WrappedUSDT.sol`, so both sources go in and solc resolves the import from
 * the source keys — never from the filesystem, which keeps the bytecode exactly
 * the checkout's.
 */
export function compileVault(): CompiledContract {
  compiledVault ??= compileSources(
    {
      "WrappedUSDT.sol": fs.readFileSync(WUSDT_SOURCE_PATH, "utf8"),
      "TreasuryVault.sol": fs.readFileSync(VAULT_SOURCE_PATH, "utf8"),
    },
    "TreasuryVault.sol",
    "TreasuryVault",
  );
  return compiledVault;
}

/**
 * A plain provider: no static network, so `getNetwork()` reports what the node
 * actually is — that is how a gate proves it is talking to mainnet.
 */
export function provider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

export async function chainIdOf(p: JsonRpcProvider): Promise<number> {
  const network = await p.getNetwork();
  return Number(network.chainId);
}

export async function codePresent(p: JsonRpcProvider, address: string): Promise<boolean> {
  const code = await p.getCode(address);
  return Boolean(code) && code !== "0x";
}

export async function nativeBalance(p: JsonRpcProvider, address: string): Promise<bigint> {
  return p.getBalance(address);
}

export async function tokenBalance(p: JsonRpcProvider, token: string, address: string): Promise<bigint> {
  const contract = new Contract(token, ERC20_VIEW_ABI as unknown as string[], p) as any;
  return (await contract.balanceOf(address)) as bigint;
}

export interface TokenRead {
  name: string;
  symbol: string;
  decimals: number;
}

export async function readToken(p: JsonRpcProvider, address: string): Promise<TokenRead> {
  const contract = new Contract(address, ERC20_VIEW_ABI as unknown as string[], p) as any;
  const [name, symbol, decimals] = (await Promise.all([
    contract.name() as Promise<string>,
    contract.symbol() as Promise<string>,
    contract.decimals() as Promise<bigint>,
  ])) as [string, string, bigint];
  return { name, symbol, decimals: Number(decimals) };
}

export interface WusdtRead extends TokenRead {
  governor: string;
  minter: string;
  totalSupply: bigint;
}

export async function readWusdt(p: JsonRpcProvider, address: string): Promise<WusdtRead> {
  const token = await readToken(p, address);
  const contract = new Contract(address, WUSDT_ABI as unknown as string[], p) as any;
  const [governor, minter, totalSupply] = (await Promise.all([
    contract.governor() as Promise<string>,
    contract.minter() as Promise<string>,
    contract.totalSupply() as Promise<bigint>,
  ])) as [string, string, bigint];
  return { ...token, governor, minter, totalSupply };
}

export function addressForKey(privateKey: string): string {
  return new Wallet(privateKey).address;
}

export interface VaultRead {
  address: string;
  governor: string;
  wusdt: string;
  decimals: number;
  reserveRaw: bigint;
  maxReserveRaw: bigint;
  redemptionReleasedRaw: bigint;
  driftRaw: bigint;
  utilizationBps: number;
  paused: boolean;
}

export const VAULT_ROLES = ["ADMIN_ROLE", "BRIDGE_ROLE", "OPERATOR_ROLE", "PAUSER_ROLE"] as const;
export type VaultRoleName = (typeof VAULT_ROLES)[number];

export async function readVault(p: JsonRpcProvider, address: string): Promise<VaultRead> {
  const vault = new Contract(address, VAULT_ABI as unknown as string[], p) as any;
  const [governor, wusdt, decimals, reserve, maxReserve, released, drift, utilization, paused] = (await Promise.all([
    vault.governor() as Promise<string>,
    vault.wUSDT() as Promise<string>,
    vault.decimals() as Promise<bigint>,
    vault.currentReserve() as Promise<bigint>,
    vault.maxReserve() as Promise<bigint>,
    vault.redemptionReleased() as Promise<bigint>,
    vault.reserveDrift() as Promise<bigint>,
    vault.getUtilizationBps() as Promise<bigint>,
    vault.paused() as Promise<boolean>,
  ])) as [string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean];

  return {
    address,
    governor,
    wusdt,
    decimals: Number(decimals),
    reserveRaw: reserve,
    maxReserveRaw: maxReserve,
    redemptionReleasedRaw: released,
    driftRaw: drift,
    utilizationBps: Number(utilization),
    paused,
  };
}

/** Does `account` hold `role` on this vault? The role ids are read, never hardcoded. */
export async function vaultHasRole(
  p: JsonRpcProvider,
  vaultAddress: string,
  role: VaultRoleName,
  account: string,
): Promise<boolean> {
  const vault = new Contract(vaultAddress, VAULT_ABI as unknown as string[], p) as any;
  const roleId = (await vault[role]()) as string;
  return (await vault.hasRole(roleId, account)) as boolean;
}

export interface FleetResult {
  address: string;
  vault: string;
  deployTxHash: string;
  vaultDeployTxHash: string;
  setMinterTxHash: string;
  grantBridgeTxHash: string;
  grantOperatorTxHash: string;
  setGovernorTxHash?: string;
  vaultSetGovernorTxHash?: string;
  receipt: TransactionReceipt | null;
}

/**
 * Deploy the reserve fleet for one chain: wUSDT, its TreasuryVault, and the
 * wiring that makes the vault the token's ONLY minter.
 *
 * Transaction order matters — every governor-only step happens before the
 * hand-over, because after it the deploy key has no authority on either
 * contract:
 *
 *  1. deploy wUSDT (governor = the deploy key, this chain's USDT decimals)
 *  2. deploy TreasuryVault(wUSDT, governor = the deploy key, same decimals)
 *  3. `setMinter(vault)` — supply can only appear afterwards through the vault's
 *     replay-protected `injectNetReserve`
 *  4. grant `BRIDGE_ROLE` + `OPERATOR_ROLE` to the platform's custody signer, so
 *     it can inject a cycle, distribute the 25 % batch and release a redemption
 *  5. hand governance of BOTH contracts to the launch multisig when
 *     `LAUNCH_GOVERNOR` is set — admin and pausing stay with governance
 */
export async function deployFleet(opts: {
  provider: JsonRpcProvider;
  privateKey: string;
  decimals: number;
  /** Custody signer: holds the vault's BRIDGE_ROLE and OPERATOR_ROLE. */
  operator: string;
  handOffGovernorTo?: string;
}): Promise<FleetResult> {
  const base = new Wallet(opts.privateKey, opts.provider);
  const governor = base.address;

  // Eight transactions in a row from one account. The nonce is tracked locally
  // instead of re-read from the node, for the same reason the platform's own
  // signers do it: re-reading races the provider's block cache.
  const signatory = new NonceManager(base);

  const tokenArtifact = compileWusdt();
  const tokenFactory = new ContractFactory(tokenArtifact.abi as any, tokenArtifact.bytecode, signatory);
  const token = await tokenFactory.deploy(WUSDT_NAME, WUSDT_SYMBOL, opts.decimals, governor);
  const deployTx = token.deploymentTransaction();
  if (!deployTx) throw new Error("the wUSDT deployment produced no transaction");
  await token.waitForDeployment();
  const address = await token.getAddress();

  const vaultArtifact = compileVault();
  const vaultFactory = new ContractFactory(vaultArtifact.abi as any, vaultArtifact.bytecode, signatory);
  const vaultContract = await vaultFactory.deploy(address, governor, opts.decimals);
  const vaultDeployTx = vaultContract.deploymentTransaction();
  if (!vaultDeployTx) throw new Error("the TreasuryVault deployment produced no transaction");
  await vaultContract.waitForDeployment();
  const vaultAddress = await vaultContract.getAddress();

  const tokenAsGovernor = new Contract(address, WUSDT_ABI as unknown as string[], signatory) as any;
  const minterTx = await tokenAsGovernor.setMinter(vaultAddress);
  const receipt = (await minterTx.wait(1)) as TransactionReceipt | null;

  const vaultAsGovernor = new Contract(vaultAddress, VAULT_ABI as unknown as string[], signatory) as any;
  const [bridgeRole, operatorRole] = (await Promise.all([
    vaultAsGovernor.BRIDGE_ROLE() as Promise<string>,
    vaultAsGovernor.OPERATOR_ROLE() as Promise<string>,
  ])) as [string, string];

  const bridgeTx = await vaultAsGovernor.grantRole(bridgeRole, opts.operator);
  await bridgeTx.wait(1);
  const operatorTx = await vaultAsGovernor.grantRole(operatorRole, opts.operator);
  await operatorTx.wait(1);

  let setGovernorTxHash: string | undefined;
  let vaultSetGovernorTxHash: string | undefined;
  const handOff = opts.handOffGovernorTo ?? "";
  if (handOff && handOff.toLowerCase() !== governor.toLowerCase()) {
    const tokenHandover = await tokenAsGovernor.setGovernor(handOff);
    await tokenHandover.wait(1);
    setGovernorTxHash = tokenHandover.hash;

    const vaultHandover = await vaultAsGovernor.setGovernor(handOff);
    await vaultHandover.wait(1);
    vaultSetGovernorTxHash = vaultHandover.hash;
  }

  return {
    address,
    vault: vaultAddress,
    deployTxHash: deployTx.hash,
    vaultDeployTxHash: vaultDeployTx.hash,
    setMinterTxHash: minterTx.hash,
    grantBridgeTxHash: bridgeTx.hash,
    grantOperatorTxHash: operatorTx.hash,
    setGovernorTxHash,
    vaultSetGovernorTxHash,
    receipt,
  };
}
