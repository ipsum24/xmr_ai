/**
 * Explorer deep links. Links are always DERIVED from (chain, hash) — never
 * accepted as input from a client, so a transaction can only ever link to the
 * explorer of the chain it was actually broadcast on.
 */

import { CHAIN_REGISTRY, type ChainName } from "./chains";

export interface ExplorerLinks {
  tx: (hash: string) => string;
  address: (address: string) => string;
  token: (address: string) => string;
}

const ETHERSCAN = (base: string): ExplorerLinks => ({
  tx: (hash) => `${base}/tx/${hash}`,
  address: (address) => `${base}/address/${address}`,
  token: (address) => `${base}/token/${address}`,
});

export const EXPLORERS: Record<ChainName, ExplorerLinks> = {
  ethereum: ETHERSCAN("https://etherscan.io"),
  bsc: ETHERSCAN("https://bscscan.com"),
  arbitrum: ETHERSCAN("https://arbiscan.io"),
  polygon: ETHERSCAN("https://polygonscan.com"),
  tron: {
    tx: (hash) => `https://tronscan.org/#/transaction/${hash}`,
    address: (address) => `https://tronscan.org/#/address/${address}`,
    token: (address) => `https://tronscan.org/#/token20/${address}`,
  },
};

export function txLink(chain: ChainName, hash: string): string {
  return EXPLORERS[chain].tx(hash);
}

export function addressLink(chain: ChainName, address: string): string {
  return EXPLORERS[chain].address(address);
}

export function tokenLink(chain: ChainName, address: string): string {
  return EXPLORERS[chain].token(address);
}

/**
 * Explorer URL for a transaction, or `null` when the chain the transaction ran
 * on has no public explorer (a local devnet) — in that case the console shows
 * the real hash without pretending a public explorer can resolve it.
 */
export function explorerUrlFor(
  chain: ChainName,
  hash: string,
  explorerBaseOverride?: string | null,
): string | null {
  // `undefined` = no override (use the chain's public explorer); an explicit
  // `null` = this chain has none, which is the case on a local devnet.
  const base = explorerBaseOverride === undefined ? CHAIN_REGISTRY[chain].explorerBase : explorerBaseOverride;
  if (!base) return null;
  if (chain === "tron") return `${base}/#/transaction/${hash}`;
  return `${base}/tx/${hash}`;
}
