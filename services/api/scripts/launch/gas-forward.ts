/**
 * GAS FORWARD — every recipient wallet holds its own gas, on all four chains.
 *
 * The platform never pays a third party's fees out of the custody key at
 * transaction time: each recipient address is topped up with a native-gas float
 * sized from that chain's LIVE fee data (never a hardcoded price), so the
 * recipient signs its own transactions and pays the gas fees itself.
 *
 * Idempotent — a wallet that already holds the float is skipped, so a second run
 * sends nothing. Fail-closed — live mode only, every chain must answer as the
 * mainnet the chain registry says it is, and custody must still cover its own
 * launch budget after the float: otherwise NOTHING is broadcast on that chain.
 *
 *   docker compose exec -T api npx tsx services/api/scripts/launch/gas-forward.ts
 *   … --chains=ethereum,bsc
 *
 * Recipients come from GAS_FORWARD_TO_<CHAIN>, else GAS_FORWARD_TO, else
 * APP_WALLET_ADDRESSES — the same addresses the console distributes to.
 */
import { NonceManager, Wallet, formatEther, type JsonRpcProvider } from "ethers";
import {
  GateReport,
  banner,
  custodyKey,
  env,
  explorerTxUrl,
  gasForwardTargets,
  label,
  registryChainId,
  rpcEnvName,
  rpcUrl,
  shortError,
  targetChains,
} from "./lib/env";
import { addressForKey, chainIdOf, nativeBalance, provider } from "./lib/fleet";

/** Gas one signed wUSDT transfer needs on the platform path, with headroom. */
const GAS_UNITS_PER_TRANSFER = 65_000n;
/** Transfers the float we forward must cover — overridable with GAS_FLOAT_TRANSFERS. */
const DEFAULT_FLOAT_TRANSFERS = 10;
/** Gas the custody key keeps for its own launch work (≈10 full deploys), on top of every float. */
const CUSTODY_LAUNCH_GAS = 50_000_000n;
const RECEIPT_TIMEOUT_MS = 5 * 60_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const chains = targetChains();
const report = new GateReport("gas-forward");
banner("GAS FORWARD — recipients pay their own fees", [
  `chains: ${chains.join(", ")}`,
  `float per recipient: ${DEFAULT_FLOAT_TRANSFERS} transfers × ${GAS_UNITS_PER_TRANSFER} gas at the chain's live fee data`,
]);

// Only live wallets are funded: forwarding gas is moving real native value.
const mode = env("CHAIN_MODE");
if (mode !== "live") {
  report.fail("env", "CHAIN_MODE=live", `CHAIN_MODE=${mode || "unset"} — the gas float is a live-mode action (devnet wallets are funded at bootstrap)`);
  report.finish({ chains, forwarded: {} });
}

const key = custodyKey();
if (!key) {
  report.fail("custody", "LIVE_SIGNER_PRIVATE_KEY set", "not set — there is no funded key to forward from");
  report.finish({ chains, forwarded: {} });
}

const custodyAddress = addressForKey(key);
console.log(`custody key: ${custodyAddress} (pays the forward, then keeps its launch budget)`);

const floatTransfersRaw = env("GAS_FLOAT_TRANSFERS");
if (floatTransfersRaw && !/^[1-9]\d*$/.test(floatTransfersRaw)) {
  report.fail("env", "GAS_FLOAT_TRANSFERS is a positive integer", `got "${floatTransfersRaw}"`);
  report.finish({ chains, forwarded: {} });
}
const floatTransfers = floatTransfersRaw ? BigInt(floatTransfersRaw) : BigInt(DEFAULT_FLOAT_TRANSFERS);

const forwarded: Record<string, { address: string; amountWei: string; txHash: string }[]> = {};

for (const chain of chains) {
  const rpc = rpcUrl(chain);
  if (!rpc) {
    report.fail(chain, `${rpcEnvName(chain)} set`, "not set — nothing to forward onto");
    continue;
  }

  const invalid = gasForwardTargets(chain).filter((address) => !EVM_ADDRESS.test(address));
  if (invalid.length > 0) {
    report.fail(chain, "recipient addresses are EVM addresses", invalid.join(", "));
    continue;
  }
  const recipients = gasForwardTargets(chain).filter((address) => address.toLowerCase() !== custodyAddress.toLowerCase());
  if (recipients.length === 0) {
    report.fail(
      chain,
      "at least one recipient wallet",
      "set GAS_FORWARD_TO (or APP_WALLET_ADDRESSES) — otherwise there is nobody to keep able to pay gas",
    );
    continue;
  }

  forwarded[chain] = [];
  try {
    await forwardOnChain(chain, provider(rpc), recipients);
  } catch (err) {
    report.fail(chain, "gas forward", shortError(err));
  }
}

report.finish({ chains, custody: custodyAddress, forwarded });

/** Top up every recipient that does not already hold the float, then prove they can pay their own gas. */
async function forwardOnChain(chain: (typeof chains)[number], p: JsonRpcProvider, recipients: string[]): Promise<void> {
  const actualChainId = await chainIdOf(p);
  if (!report.record(chain, `RPC is ${label(chain)} (chain id ${registryChainId(chain)})`, actualChainId === registryChainId(chain), `chain id ${actualChainId}`)) {
    return; // never move value on a chain we failed to identify
  }

  const feePerGas = await liveFeePerGas(p);
  const gasForOneTransfer = GAS_UNITS_PER_TRANSFER * feePerGas;
  const target = gasForOneTransfer * BigInt(floatTransfers);
  report.note(chain, "live fee data", `${feePerGas} wei/gas — float target ${formatEther(target)} native per wallet`);

  const plan: { address: string; balance: bigint; topUp: bigint }[] = [];
  for (const address of recipients) {
    const balance = await nativeBalance(p, address);
    plan.push({ address, balance, topUp: balance >= target ? 0n : target - balance });
  }
  const pending = plan.filter((entry) => entry.topUp > 0n);
  const total = pending.reduce((sum, entry) => sum + entry.topUp, 0n);
  /** Balance each recipient was verified to hold at the block its float landed in. */
  const landed = new Map<string, bigint>();

  if (pending.length === 0) {
    report.record(chain, "every recipient already holds its own gas float", true, `${recipients.length} wallet(s) ≥ ${formatEther(target)} native`);
  } else {
    // Custody pays for this float and still needs gas of its own for the launch.
    const custodyBalance = await nativeBalance(p, custodyAddress);
    const keep = CUSTODY_LAUNCH_GAS * feePerGas;
    if (custodyBalance < total + keep) {
      report.fail(
        chain,
        "custody can fund the float and keep its launch budget",
        `custody ${formatEther(custodyBalance)} native < ${formatEther(total + keep)} needed ` +
          `(${formatEther(total)} float + ${formatEther(keep)} launch budget) — nothing sent on ${label(chain)}`,
      );
      return;
    }

    // One signer per chain, nonce tracked locally: the sends are sequential and
    // re-reading the nonce races the provider's block cache (same discipline as
    // the deploy gate and the platform's own broadcaster).
    const signer = new NonceManager(new Wallet(key, p));
    for (const entry of pending) {
      const tx = await signer.sendTransaction({ to: entry.address, value: entry.topUp });
      const receipt = await tx.wait(1, RECEIPT_TIMEOUT_MS);
      // Read back AT the receipt's block: the provider serves `latest` from a
      // cached block number, so a plain latest read can still report the
      // pre-transfer balance and mark a float that landed as missing.
      const after = receipt ? await p.getBalance(entry.address, receipt.blockNumber) : 0n;
      const ok = receipt?.status === 1 && after === entry.balance + entry.topUp;
      report.record(
        chain,
        `forwarded gas to ${entry.address}`,
        ok,
        `${formatEther(entry.topUp)} native — balance ${formatEther(entry.balance)} → ${formatEther(after)}`,
      );
      if (ok) {
        landed.set(entry.address, after);
        forwarded[chain].push({ address: entry.address, amountWei: entry.topUp.toString(), txHash: tx.hash });
      }
      report.note(chain, "forward tx", explorerTxUrl(chain, tx.hash));
    }
  }

  // What the float is FOR: the recipient can now sign and pay for its own transfer.
  for (const address of recipients) {
    const balance = landed.get(address) ?? plan.find((entry) => entry.address === address)?.balance ?? 0n;
    report.record(
      chain,
      `${address} pays its own gas fees`,
      balance >= gasForOneTransfer,
      `${formatEther(balance)} native ≥ ${formatEther(gasForOneTransfer)} for a wUSDT transfer at live fees`,
    );
  }
}

/** Live fee data, or a hard stop — a float sized from stale or zero fees is worthless. */
async function liveFeePerGas(p: JsonRpcProvider): Promise<bigint> {
  const fee = await p.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (!price || price <= 0n) throw new Error("the RPC returned no usable fee data — refusing to size a gas float from it");
  return price;
}

