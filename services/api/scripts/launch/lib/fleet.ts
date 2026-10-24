/**
 * Fleet mechanics for the launch gates: compile wUSDT from THIS checkout's own
 * Solidity source, deploy it, and read it back from chain.
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

const SOURCE_PATH = fileURLToPath(new URL("../../../../../contracts/src/WrappedUSDT.sol", import.meta.url));

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

export interface CompiledWusdt {
  abi: readonly unknown[];
  bytecode: string;
}

let compiled: CompiledWusdt | null = null;

/** solc, straight from the repo source — the bytecode the gates deploy. */
export function compileWusdt(): CompiledWusdt {
  if (compiled) return compiled;

  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const input = {
    language: "Solidity",
    sources: { "WrappedUSDT.sol": { content: source } },
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

  const artifact = output.contracts?.["WrappedUSDT.sol"]?.["WrappedUSDT"];
  const bytecode = artifact?.evm?.bytecode?.object;
  if (!bytecode) throw new Error(`WrappedUSDT did not compile from ${SOURCE_PATH}`);

  compiled = { abi: artifact.abi, bytecode: `0x${bytecode}` };
  return compiled;
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

export interface DeployResult {
  address: string;
  deployTxHash: string;
  setMinterTxHash: string;
  setGovernorTxHash?: string;
  receipt: TransactionReceipt | null;
}

/**
 * Deploy wUSDT and hand the minter role to the mint engine's signer.
 *
 * The deploy key must be the governor passed in, because it is the account that
 * signs `setMinter`. When LAUNCH_GOVERNOR names a multisig, governance is handed
 * over in a third, separate transaction — the deploy key keeps no authority.
 */
export async function deployWusdt(opts: {
  provider: JsonRpcProvider;
  privateKey: string;
  decimals: number;
  governor: string;
  minter: string;
  handOffGovernorTo?: string;
}): Promise<DeployResult> {
  const base = new Wallet(opts.privateKey, opts.provider);
  if (base.address.toLowerCase() !== opts.governor.toLowerCase()) {
    throw new Error(`the deploy key (${base.address}) must be the governor passed to the constructor`);
  }

  // Three transactions in a row from one account (deploy → setMinter →
  // setGovernor). The nonce is tracked locally instead of re-read from the
  // node, for the same reason the platform's own signers do it: re-reading
  // races the provider's block cache.
  const signatory = new NonceManager(base);

  const { abi, bytecode } = compileWusdt();
  const factory = new ContractFactory(abi as any, bytecode, signatory);
  const deployed = await factory.deploy(WUSDT_NAME, WUSDT_SYMBOL, opts.decimals, opts.governor);
  const deployTx = deployed.deploymentTransaction();
  if (!deployTx) throw new Error("deployment produced no transaction");

  await deployed.waitForDeployment();
  const address = await deployed.getAddress();

  const contract = new Contract(address, WUSDT_ABI as unknown as string[], signatory) as any;
  const minterTx = await contract.setMinter(opts.minter);
  const receipt = (await minterTx.wait(1)) as TransactionReceipt | null;

  let setGovernorTxHash: string | undefined;
  if (opts.handOffGovernorTo && opts.handOffGovernorTo.toLowerCase() !== opts.governor.toLowerCase()) {
    const governorTx = await contract.setGovernor(opts.handOffGovernorTo);
    await governorTx.wait(1);
    setGovernorTxHash = governorTx.hash;
  }

  return { address, deployTxHash: deployTx.hash, setMinterTxHash: minterTx.hash, setGovernorTxHash, receipt };
}
