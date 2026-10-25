import { Contract, FetchRequest, JsonRpcProvider, parseUnits } from "ethers";
import { CHAIN_REGISTRY, type ChainName } from "../../../src/shared";
import { rpcEnvName } from "./env";
import { LaunchError, SecretsResolver } from "./secrets-resolver";

export interface DeploymentNetwork {
  chain: ChainName;
  provider: JsonRpcProvider;
  urls: string[];
  fee: bigint;
  gasBudget: bigint;
}

export function positiveInteger(raw: string, fallback: number): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new LaunchError("Deployment limits must be positive safe integers");
  return value;
}

export function assertFreshBlock(timestamp: number, now = Date.now()): void {
  const age = now / 1000 - timestamp;
  if (!Number.isFinite(age) || age > 300 || age < -60) throw new LaunchError("RPC head is stale or has an invalid timestamp");
}

export async function currentFee(p: JsonRpcProvider): Promise<bigint> {
  const fee = await p.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (!price || price <= 0n) throw new LaunchError("RPC returned no usable live gas price");
  return price;
}

export function assertFee(price: bigint, baseline: bigint, absoluteLimit?: string): void {
  if (price <= 0n || price > baseline * 2n || (absoluteLimit && price > parseUnits(absoluteLimit, "gwei"))) {
    throw new LaunchError("Live gas fee exceeded the configured ceiling or doubled since preflight");
  }
}

export async function resolveEndpoints(chain: ChainName, resolver: SecretsResolver): Promise<string[]> {
  const primary = await resolver.get(rpcEnvName(chain));
  const secondary = await resolver.get(`${rpcEnvName(chain)}_2`);
  const urls = [...new Set([primary, secondary].filter(Boolean))];
  if (!urls.length) throw new LaunchError(`Missing mainnet endpoint ${rpcEnvName(chain)}`);
  for (const raw of urls) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new LaunchError(`Invalid endpoint in ${rpcEnvName(chain)}`); }
    if (url.protocol !== "https:" || url.hash || /testnet|sepolia|amoy|localhost|127\.0\.0\.1|devnet/i.test(url.hostname)) {
      throw new LaunchError(`${rpcEnvName(chain)} must be an HTTPS mainnet endpoint without URL fragments`);
    }
  }
  return urls;
}

export async function probeNetwork(chain: ChainName, urls: string[], signer: string, gasBudget: bigint): Promise<DeploymentNetwork> {
  for (const url of urls) {
    const request = new FetchRequest(url);
    request.timeout = 10_000;
    const p = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
    p.pollingInterval = 1_000;
    try {
      const registry = CHAIN_REGISTRY[chain];
      if (Number((await p.getNetwork()).chainId) !== registry.chainId) throw new Error("chain mismatch");
      const block = await p.getBlock("latest");
      if (!block) throw new Error("missing head");
      assertFreshBlock(block.timestamp);
      if (await p.getCode(registry.usdt) === "0x") throw new Error("missing official USDT");
      const token = new Contract(registry.usdt, ["function decimals() view returns (uint8)"], p);
      if (Number(await token.decimals()) !== registry.usdtDecimals) throw new Error("USDT decimals mismatch");
      const fee = await currentFee(p);
      if (await p.getBalance(signer) < gasBudget * fee) throw new Error("insufficient gas budget");
      return { chain, provider: p, urls, fee, gasBudget };
    } catch { p.destroy(); }
  }
  // Do not include URLs, which often contain the provider's API key.
  throw new LaunchError(`${chain}: no endpoint passed chain ID, head freshness, official USDT and gas-budget checks`);
}
