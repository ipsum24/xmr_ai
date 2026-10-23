import { Contract, type TransactionResponse } from "ethers";
import { prisma } from "../db";
import { CHAIN_REGISTRY, explorerUrlFor, fromRaw, type ChainName } from "../shared";
import { attachHash, createTransaction, markFailedById } from "../transactions/service";
import { ERC20_ABI, LOCAL_DEX_ABI, UNISWAP_V3_ROUTER_ABI } from "./abi";
import { signerFor, ROLE } from "./rpc";
import { signerForWallet } from "./wallets";

export interface BroadcastResult {
  txId: string;
  hash: string;
  status: string;
  chain: ChainName;
  direction: string;
  amountRaw: string;
  amountHuman: string;
  tokenSymbol: string;
  explorerUrl: string | null;
  dex?: string;
}

export type TokenKind = "wusdt" | "usdt";

interface BroadcastInput {
  chain: ChainName;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  tokenId: string;
  tokenSymbol: string;
  decimals: number;
  adminId?: string | null;
  note?: string;
  send: () => Promise<TransactionResponse>;
}

async function deploymentFor(chain: ChainName) {
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (!deployment) throw new Error(`chain ${chain} is not configured`);
  return deployment;
}

/**
 * Ledger first (CEI): the intent row is written before the broadcast, the hash
 * is attached by the broadcaster, and the handshake watcher flips the row to
 * confirmed once the receipt is in. Nothing here accepts a caller-supplied hash.
 */
async function broadcast(input: BroadcastInput): Promise<BroadcastResult> {
  const row = await createTransaction({
    chain: input.chain,
    direction: input.direction,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    amount: input.amountRaw,
    tokenId: input.tokenId,
    tokenSymbol: input.tokenSymbol,
    decimals: input.decimals,
    initiatedByAdminId: input.adminId ?? null,
    note: input.note,
  });

  try {
    const response = await input.send();
    if (!response?.hash) throw new Error("broadcast returned no transaction hash");
    const updated = await attachHash(row.id, response.hash, "broadcaster:evm");
    const deployment = await deploymentFor(input.chain);
    return {
      txId: row.id,
      hash: response.hash,
      status: updated.status,
      chain: input.chain,
      direction: input.direction,
      amountRaw: input.amountRaw,
      amountHuman: fromRaw(input.amountRaw, input.decimals),
      tokenSymbol: input.tokenSymbol,
      explorerUrl: explorerUrlFor(input.chain, response.hash, deployment.explorerBase),
    };
  } catch (err) {
    const message = (err as { shortMessage?: string })?.shortMessage ?? (err as Error)?.message ?? String(err);
    await markFailedById(row.id, message);
    throw new Error(message);
  }
}

function tokenAddress(deployment: { wusdt: string; usdt: string }, token: TokenKind): string {
  return token === "wusdt" ? deployment.wusdt : deployment.usdt;
}

function tokenSymbol(token: TokenKind): string {
  return token === "wusdt" ? "wUSDT" : "USDT";
}

async function walletRow(walletId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  return wallet;
}

/** Mint new wUSDT. Only the treasury vault signer holds the minter role. */
export async function mintWusdt(
  chain: ChainName,
  toAddress: string,
  amountRaw: string,
  options: { adminId?: string | null; note?: string } = {},
): Promise<BroadcastResult> {
  const deployment = await deploymentFor(chain);
  const signer = signerFor(chain, ROLE.treasuryVault);
  const contract = new Contract(deployment.wusdt, ERC20_ABI as unknown as string[], signer as any) as any;
  return broadcast({
    chain,
    direction: "mint",
    fromAddress: signer.address,
    toAddress,
    amountRaw,
    tokenId: deployment.wusdt,
    tokenSymbol: "wUSDT",
    decimals: deployment.wusdtDecimals,
    adminId: options.adminId,
    note: options.note ?? "platform mint engine",
    send: () => contract.mint(toAddress, amountRaw),
  });
}

/** Burn wUSDT held by a platform wallet (redemption path). */
export async function burnWusdt(
  chain: ChainName,
  walletId: string,
  amountRaw: string,
  options: { adminId?: string | null; note?: string } = {},
): Promise<BroadcastResult> {
  const deployment = await deploymentFor(chain);
  const wallet = await walletRow(walletId);
  const signer = signerForWallet(chain, wallet);
  const contract = new Contract(deployment.wusdt, ERC20_ABI as unknown as string[], signer as any) as any;
  return broadcast({
    chain,
    direction: "burn",
    fromAddress: wallet.address,
    toAddress: "0x0000000000000000000000000000000000000000",
    amountRaw,
    tokenId: deployment.wusdt,
    tokenSymbol: "wUSDT",
    decimals: deployment.wusdtDecimals,
    adminId: options.adminId,
    note: options.note ?? "platform burn engine",
    send: () => contract.burn(amountRaw),
  });
}

/** Move wUSDT or real USDT out of a platform wallet. */
export async function transferToken(
  chain: ChainName,
  token: TokenKind,
  fromWalletId: string,
  toAddress: string,
  amountRaw: string,
  options: { adminId?: string | null; note?: string; direction?: string } = {},
): Promise<BroadcastResult> {
  const deployment = await deploymentFor(chain);
  const wallet = await walletRow(fromWalletId);
  const signer = signerForWallet(chain, wallet);
  const address = tokenAddress(deployment, token);
  const decimals = token === "wusdt" ? deployment.wusdtDecimals : deployment.usdtDecimals;
  const contract = new Contract(address, ERC20_ABI as unknown as string[], signer as any) as any;

  return broadcast({
    chain,
    direction: options.direction ?? "transfer_out",
    fromAddress: wallet.address,
    toAddress,
    amountRaw,
    tokenId: address,
    tokenSymbol: tokenSymbol(token),
    decimals,
    adminId: options.adminId,
    note: options.note,
    send: () => contract.transfer(toAddress, amountRaw),
  });
}

/**
 * Exact-amount approval (USDT-style tokens get approve(0) first, never an
 * infinite approval).
 */
export async function approveToken(
  chain: ChainName,
  token: TokenKind,
  fromWalletId: string,
  spender: string,
  amountRaw: string,
  options: { adminId?: string | null; resetFirst?: boolean } = {},
): Promise<BroadcastResult> {
  const deployment = await deploymentFor(chain);
  const wallet = await walletRow(fromWalletId);
  const signer = signerForWallet(chain, wallet);
  const address = tokenAddress(deployment, token);
  const decimals = token === "wusdt" ? deployment.wusdtDecimals : deployment.usdtDecimals;
  const contract = new Contract(address, ERC20_ABI as unknown as string[], signer as any) as any;

  if (options.resetFirst) {
    const current = await contract.allowance(wallet.address, spender);
    if (BigInt(current) !== 0n) {
      await broadcast({
        chain,
        direction: "approve",
        fromAddress: wallet.address,
        toAddress: spender,
        amountRaw: "0",
        tokenId: address,
        tokenSymbol: tokenSymbol(token),
        decimals,
        adminId: options.adminId,
        note: "reset approval to zero",
        send: () => contract.approve(spender, 0),
      });
    }
  }

  return broadcast({
    chain,
    direction: "approve",
    fromAddress: wallet.address,
    toAddress: spender,
    amountRaw,
    tokenId: address,
    tokenSymbol: tokenSymbol(token),
    decimals,
    adminId: options.adminId,
    note: `exact approval for ${spender}`,
    send: () => contract.approve(spender, amountRaw),
  });
}

/**
 * Swap wUSDT → official USDT through the chain's DEX.
 *
 * devnet routes through the local liquidity router; live EVM chains route
 * through the real DEX router (Uniswap V3 / PancakeSwap V3 shape) configured in
 * SWAP_ROUTER_<CHAIN>. TRON's SunSwap path is not implemented in this slice.
 */
export async function swapWusdtForUsdt(
  chain: ChainName,
  fromWalletId: string,
  amountInRaw: string,
  minOutRaw: string,
  options: { adminId?: string | null } = {},
): Promise<BroadcastResult & { approvalTxId?: string }> {
  const deployment = await deploymentFor(chain);
  if (!deployment.dexRouter) throw new Error(`no DEX router configured for ${chain}`);
  if (CHAIN_REGISTRY[chain].family === "tron") {
    throw new Error("TRON swap path (SunSwap) is not implemented in this slice");
  }

  const wallet = await walletRow(fromWalletId);
  const signer = signerForWallet(chain, wallet);

  let approvalTxId: string | undefined;
  const wusdt = new Contract(deployment.wusdt, ERC20_ABI as unknown as string[], signer as any) as any;
  const allowance: bigint = await wusdt.allowance(wallet.address, deployment.dexRouter);
  if (allowance < BigInt(amountInRaw)) {
    const approval = await approveToken(chain, "wusdt", fromWalletId, deployment.dexRouter, amountInRaw, {
      adminId: options.adminId,
      resetFirst: true,
    });
    approvalTxId = approval.txId;
  }

  if (deployment.mode === "devnet") {
    const router = new Contract(deployment.dexRouter, LOCAL_DEX_ABI as unknown as string[], signer as any) as any;
    const result = await broadcast({
      chain,
      direction: "swap",
      fromAddress: wallet.address,
      toAddress: deployment.dexRouter,
      amountRaw: amountInRaw,
      tokenId: deployment.usdt,
      tokenSymbol: "USDT",
      decimals: deployment.usdtDecimals,
      adminId: options.adminId,
      note: `swap wUSDT→USDT via ${deployment.dexName}`,
      send: () => router.swapExactWusdtForUsdt(amountInRaw, minOutRaw),
    });
    return { ...result, approvalTxId, dex: deployment.dexName };
  }

  const router = new Contract(deployment.dexRouter, UNISWAP_V3_ROUTER_ABI as unknown as string[], signer as any) as any;
  const result = await broadcast({
    chain,
    direction: "swap",
    fromAddress: wallet.address,
    toAddress: deployment.dexRouter,
    amountRaw: amountInRaw,
    tokenId: deployment.usdt,
    tokenSymbol: "USDT",
    decimals: deployment.usdtDecimals,
    adminId: options.adminId,
    note: `swap wUSDT→USDT via ${deployment.dexName}`,
    send: () =>
      router.exactInputSingle({
        tokenIn: deployment.wusdt,
        tokenOut: deployment.usdt,
        fee: Number(process.env.SWAP_FEE_BIPS ?? 500),
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
        amountIn: amountInRaw,
        amountOutMinimum: minOutRaw,
        sqrtPriceLimitX96: 0,
      }),
  });
  return { ...result, approvalTxId, dex: deployment.dexName };
}
