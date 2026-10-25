import { Contract, id, type JsonRpcProvider } from "ethers";
import { CHAIN_REGISTRY, type ChainName } from "../../../src/shared";
import { readVault, readWusdt, tokenBalance, WUSDT_NAME, WUSDT_SYMBOL } from "./fleet";
import { LaunchError } from "./secrets-resolver";

export interface FleetIdentity {
  wusdt: string;
  vault: string;
  governor: string;
  deployer: string;
  bridge: string;
  operator: string;
}

/** Read actual role effects, not an indexer flag or a successful transaction. */
export async function assertDeployedEffects(p: JsonRpcProvider, chain: ChainName, fleet: FleetIdentity, fresh: boolean): Promise<void> {
  const check = (condition: boolean, message: string): void => {
    if (!condition) throw new LaunchError(`${chain}: ${message}`);
  };
  const registry = CHAIN_REGISTRY[chain];
  check(Number((await p.getNetwork()).chainId) === registry.chainId, "verification RPC chain mismatch");
  for (const address of [fleet.wusdt, fleet.vault]) check((await p.getCode(address)).length > 100, "contract bytecode missing or implausibly small");
  const token = await readWusdt(p, fleet.wusdt);
  const vault = await readVault(p, fleet.vault);
  check(token.name === WUSDT_NAME && token.symbol === WUSDT_SYMBOL, "token identity mismatch");
  check(token.decimals === registry.usdtDecimals && vault.decimals === registry.usdtDecimals, "USDT decimal scaling mismatch");
  check(token.minter.toLowerCase() === fleet.vault.toLowerCase() && vault.wusdt.toLowerCase() === fleet.wusdt.toLowerCase(), "vault/minter binding mismatch");
  check(token.governor.toLowerCase() === fleet.governor.toLowerCase() && vault.governor.toLowerCase() === fleet.governor.toLowerCase(), "governance handover incomplete");
  check(!vault.paused && vault.driftRaw === 0n && vault.reserveRaw <= vault.maxReserveRaw, "vault pause, reconciliation or capacity invariant failed");
  check(vault.maxReserveRaw === 10_000_000n * 10n ** BigInt(registry.usdtDecimals), "unexpected reserve ceiling");
  if (fresh) check(token.totalSupply === 0n && vault.reserveRaw === 0n && vault.redemptionReleasedRaw === 0n, "new fleet is not empty");
  const roleAbi = ["function hasRole(bytes32,address) view returns (bool)", "function paused() view returns (bool)"];
  const tokenRoles = new Contract(fleet.wusdt, roleAbi, p);
  const vaultRoles = new Contract(fleet.vault, roleAbi, p);
  check(!await tokenRoles.paused(), "wUSDT is paused");
  for (const contract of [tokenRoles, vaultRoles]) {
    for (const role of ["ADMIN_ROLE", "PAUSER_ROLE"]) {
      check(Boolean(await contract.hasRole(id(role), fleet.governor)), `governor lacks ${role}`);
      if (fleet.governor.toLowerCase() !== fleet.deployer.toLowerCase()) check(!await contract.hasRole(id(role), fleet.deployer), `deployer retained ${role}`);
    }
  }
  check(Boolean(await tokenRoles.hasRole(id("MINTER_ROLE"), fleet.vault)), "vault lacks MINTER_ROLE");
  for (const account of [fleet.deployer, fleet.bridge, fleet.operator]) check(!await tokenRoles.hasRole(id("MINTER_ROLE"), account), "an operational signer retained mint authority");
  check(Boolean(await vaultRoles.hasRole(id("BRIDGE_ROLE"), fleet.bridge)), "bridge lacks BRIDGE_ROLE");
  check(Boolean(await vaultRoles.hasRole(id("OPERATOR_ROLE"), fleet.operator)), "operator lacks OPERATOR_ROLE");
  if (fleet.deployer.toLowerCase() !== fleet.bridge.toLowerCase()) check(!await vaultRoles.hasRole(id("BRIDGE_ROLE"), fleet.deployer), "deployer retained bridge authority");
  if (fleet.deployer.toLowerCase() !== fleet.operator.toLowerCase()) check(!await vaultRoles.hasRole(id("OPERATOR_ROLE"), fleet.deployer), "deployer retained operator authority");
  const custody = await tokenBalance(p, registry.usdt, fleet.operator);
  check(token.totalSupply <= custody, "wrapped supply exceeds the operator's custodied USDT");
}
