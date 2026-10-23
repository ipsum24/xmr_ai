import { Contract } from "ethers";
import { config } from "../config";
import { prisma } from "../db";
import type { ChainName } from "../shared";
import { ERC20_ABI } from "./abi";
import { derivationIndex, providerFor, ROLE, signerFor } from "./rpc";

export interface WalletSpec {
  role: number;
  kind: "treasury" | "app";
  label: string;
}

export const WALLET_SPECS: WalletSpec[] = [
  { role: ROLE.treasuryVault, kind: "treasury", label: "Treasury Vault" },
  { role: ROLE.appOperations, kind: "app", label: "App Wallet · Operations" },
  { role: ROLE.appSettlement, kind: "app", label: "App Wallet · Settlement" },
];

function walletAddressesFor(chain: ChainName): { spec: WalletSpec; address: string }[] {
  if (config.chainMode === "live") {
    const treasury = signerFor(chain, ROLE.treasuryVault).address;
    const appWallets = (process.env.APP_WALLET_ADDRESSES ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    return [
      { spec: WALLET_SPECS[0], address: treasury },
      ...appWallets.map((address, i) => ({
        spec: { role: ROLE.appOperations + i, kind: "app" as const, label: `App Wallet ${i + 1}` },
        address,
      })),
    ];
  }
  return WALLET_SPECS.map((spec) => ({ spec, address: signerFor(chain, spec.role).address }));
}

/** Create/refresh the chain's wallet rows and mirror their on-chain balances. */
export async function ensureWalletRows(chain: ChainName): Promise<void> {
  for (const { spec, address } of walletAddressesFor(chain)) {
    await prisma.wallet.upsert({
      where: { chain_address: { chain, address } },
      update: { label: spec.label, kind: spec.kind },
      create: {
        chain,
        address,
        label: spec.label,
        kind: spec.kind,
        derivationIndex: derivationIndex(chain, spec.role),
      },
    });
  }
  await syncBalances(chain);
}

/**
 * Mirror on-chain balances into the platform ledger. The chain is the source of
 * truth — the DB copy only exists so the console can render without hammering
 * the RPC.
 */
export async function syncBalances(chain: ChainName): Promise<void> {
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (!deployment) return;

  const provider = providerFor(chain);
  const wallets = await prisma.wallet.findMany({ where: { chain } });
  const wusdt = new Contract(deployment.wusdt, ERC20_ABI as unknown as string[], provider) as any;
  const usdt = new Contract(deployment.usdt, ERC20_ABI as unknown as string[], provider) as any;

  for (const wallet of wallets) {
    const [wusdtBalance, usdtBalance] = await Promise.all([
      wusdt.balanceOf(wallet.address) as Promise<bigint>,
      usdt.balanceOf(wallet.address) as Promise<bigint>,
    ]);
    await upsertBalance(wallet.id, deployment.wusdt, "wUSDT", deployment.wusdtDecimals, wusdtBalance);
    await upsertBalance(wallet.id, deployment.usdt, "USDT", deployment.usdtDecimals, usdtBalance);
  }
}

async function upsertBalance(
  walletId: string,
  tokenId: string,
  symbol: string,
  decimals: number,
  balance: bigint,
): Promise<void> {
  const available = balance.toString();
  await prisma.tokenBalance.upsert({
    where: { walletId_tokenId: { walletId, tokenId } },
    update: { available, symbol, decimals },
    create: { walletId, tokenId, symbol, decimals, available },
  });
}

/** Direct on-chain balance read — the source of truth for every gate. */
export async function onChainBalance(chain: ChainName, tokenAddress: string, address: string): Promise<bigint> {
  const contract = new Contract(tokenAddress, ERC20_ABI as unknown as string[], providerFor(chain)) as any;
  return (await contract.balanceOf(address)) as bigint;
}

/** Resolve the custody signer that owns a wallet row (devnet derivation order). */export function signerForWallet(chain: ChainName, wallet: { address: string }) {
  for (const role of [ROLE.governance, ROLE.treasuryVault, ROLE.appOperations, ROLE.appSettlement]) {
    const signer = signerFor(chain, role);
    if (signer.address.toLowerCase() === wallet.address.toLowerCase()) return signer;
  }
  throw new Error(
    `no custody key available for ${wallet.address} on ${chain} — live mode can only sign with the configured custody key`,
  );
}
