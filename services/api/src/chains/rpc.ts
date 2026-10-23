import { HDNodeWallet, JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { config } from "../config";
import { CHAIN_REGISTRY, type ChainName } from "../shared";

const providers = new Map<string, JsonRpcProvider>();

export function providerFor(chain: ChainName): JsonRpcProvider {
  let provider = providers.get(chain);
  if (!provider) {
    // In devnet mode the local node is started with the real chain id, so the
    // network is known up front and ethers skips a detection round-trip.
    const chainId = config.chainMode === "devnet" ? CHAIN_REGISTRY[chain].chainId : undefined;
    provider = new JsonRpcProvider(config.rpcUrls[chain], chainId, { staticNetwork: true });
    providers.set(chain, provider);
  }
  return provider;
}

/**
 * Custody roles. Each chain gets its own key range (base = chain position × 10)
 * so a devnet chain never reuses another chain's address.
 */
export const ROLE = {
  governance: 0,
  treasuryVault: 1,
  appOperations: 2,
  appSettlement: 3,
} as const;

export function derivationIndex(chain: ChainName, role: number): number {
  const chainIndex = config.chainTargets.indexOf(chain);
  return (chainIndex < 0 ? 0 : chainIndex) * 10 + role;
}

/** A signer that keeps its own nonce and always exposes its address. */
export type ManagedSigner = NonceManager & { readonly address: string };

const signers = new Map<string, ManagedSigner>();

/**
 * Devnet: the local Anvil mnemonic, derived per chain + role.
 * Live: the single configured custody key (KMS signer is the production target).
 *
 * Signers are memoised and wrapped in a NonceManager. The platform sends several
 * transactions from one custody account in a row (deploy fleet → configure →
 * mint → distribute), and re-reading the nonce from a node that mines a block per
 * transaction races the provider's block cache — the second broadcast would reuse
 * the first nonce. The manager tracks the nonce locally instead, which is what
 * keeps chained broadcasts strictly ordered.
 */
export function signerFor(chain: ChainName, role: number): ManagedSigner {
  const key = `${chain}:${role}`;
  const cached = signers.get(key);
  if (cached) return cached;

  let base: Wallet;
  if (config.chainMode === "live") {
    if (!config.liveSignerKey) {
      throw new Error("LIVE_SIGNER_PRIVATE_KEY is required for live mode custody");
    }
    base = new Wallet(config.liveSignerKey, providerFor(chain));
  } else {
    const path = `m/44'/60'/0'/0/${derivationIndex(chain, role)}`;
    base = HDNodeWallet.fromPhrase(config.devMnemonic, undefined, path).connect(providerFor(chain));
  }

  const managed = new NonceManager(base) as ManagedSigner;
  Object.defineProperty(managed, "address", { value: base.address, enumerable: true });
  signers.set(key, managed);
  return managed;
}

/** Resync from the node's nonce after a rejected broadcast. */
export function resetSignerNonce(chain: ChainName, role: number): void {
  signers.get(`${chain}:${role}`)?.reset();
}

export function addressFor(chain: ChainName, role: number): string {
  return signerFor(chain, role).address;
}

export async function waitForRpc(chain: ChainName, timeoutMs = 60_000): Promise<void> {
  const provider = providerFor(chain);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`chain ${chain} RPC unreachable at ${config.rpcUrls[chain]}: ${String(lastError)}`);
}
