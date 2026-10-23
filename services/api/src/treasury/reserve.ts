import { Contract } from "ethers";
import { ERC20_ABI } from "../chains/abi";
import { providerFor } from "../chains/rpc";
import type { ChainName } from "../shared";

/**
 * The supply invariant, enforced in the runtime path:
 *
 *     wUSDT.totalSupply() ≤ USDT actually custodied for the vault
 *
 * Minting capacity is therefore the un-minted part of that attested reserve, so
 * no code path — startup cycle or admin mint — can create supply without
 * backing. (The Foundry invariant suite asserts the same property in tests.)
 */
export async function mintCapacityRaw(params: {
  chain: ChainName;
  wusdt: string;
  usdt: string;
  custodyAddress: string;
}): Promise<{ capacityRaw: bigint; custodyRaw: bigint; supplyRaw: bigint }> {
  const provider = providerFor(params.chain);
  const wusdt = new Contract(params.wusdt, ERC20_ABI as unknown as string[], provider) as any;
  const usdt = new Contract(params.usdt, ERC20_ABI as unknown as string[], provider) as any;

  const [supplyRaw, custodyRaw] = (await Promise.all([
    wusdt.totalSupply() as Promise<bigint>,
    usdt.balanceOf(params.custodyAddress) as Promise<bigint>,
  ])) as [bigint, bigint];

  const capacityRaw = custodyRaw > supplyRaw ? custodyRaw - supplyRaw : 0n;
  return { capacityRaw, custodyRaw, supplyRaw };
}
