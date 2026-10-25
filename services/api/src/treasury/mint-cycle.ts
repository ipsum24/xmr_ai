import { keccak256, toUtf8Bytes } from "ethers";
import { distributeReserve, injectReserve } from "../chains/broadcaster";
import { config } from "../config";
import { prisma } from "../db";
import { bpsOfRaw, fromRaw, toRaw, type ChainName } from "../shared";
import { mintCapacityRaw } from "./reserve";
import { vaultStateFor } from "./vault";

/**
 * The startup autonomous mint cycle.
 *
 * On the first boot each chain mints its $10M wUSDT target INTO the treasury
 * vault, then pushes 25 % of it out to the app wallets as separate, real
 * transfers with their own hashes. Minting is gated on attested reserve: the
 * engine only ever mints against real USDT the vault actually holds, read from
 * chain at cycle time.
 *
 * Idempotency: the startup cycle runs once per chain (cycleIndex is unique per
 * chain), so a restart never inflates supply. Later refills are explicit admin
 * actions — see POST /api/treasury/refill.
 */
export async function runStartupMintCycles(): Promise<void> {
  for (const chain of config.chainTargets) {
    const existing = await prisma.mintCycle.findFirst({ where: { chain }, orderBy: { cycleIndex: "desc" } });
    if (existing) {
      console.log(`[mint] ${chain}: cycle #${existing.cycleIndex} already recorded (${existing.status}) — skipping startup cycle`);
      continue;
    }
    try {
      await runMintCycle(chain);
    } catch (err) {
      console.error(`[mint] ${chain}: cycle failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The bridge message id for a cycle. A chain + cycle can only ever be injected
 * once, so a replayed cycle message reverts on chain instead of minting twice.
 */
export function mintCycleMessageId(chain: ChainName, cycleIndex: number): string {
  return keccak256(toUtf8Bytes(`wusdt:cycle:${chain}:${cycleIndex}`));
}

export interface MintCycleResult {
  chain: ChainName;
  cycleIndex: number;
  attestedRaw: string;
  mintedRaw: string;
  distributedRaw: string;
  mintTxId: string | null;
}

/**
 * One cycle for a chain. `targetUsd` defaults to the configured vault target;
 * the launch smoke gate passes a deliberately small target so the first real
 * cycle runs at $10k instead of the full $10M.
 */
export async function runMintCycle(chain: ChainName, targetUsd: number = config.treasuryVaultTargetUsd): Promise<MintCycleResult> {
  const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
  if (!deployment) throw new Error(`chain ${chain} is not configured`);

  const treasury = await prisma.wallet.findFirst({ where: { chain, kind: "treasury" } });
  if (!treasury) throw new Error(`no treasury wallet for ${chain}`);

  const previous = await prisma.mintCycle.findFirst({ where: { chain }, orderBy: { cycleIndex: "desc" } });
  const cycleIndex = (previous?.cycleIndex ?? 0) + 1;
  const targetRaw = toRaw(targetUsd, deployment.wusdtDecimals);

  const cycle = await prisma.mintCycle.create({
    data: { chain, cycleIndex, targetRaw, status: "running" },
  });

  try {
    // ── Reserve gate: credit only against un-minted attested USDT ───────────
    // (supply invariant: wUSDT.totalSupply() ≤ custodied USDT)
    const { capacityRaw, custodyRaw, supplyRaw } = await mintCapacityRaw({
      chain,
      wusdt: deployment.wusdt,
      usdt: deployment.usdt,
      custodyAddress: treasury.address,
    });
    const mintable = BigInt(targetRaw) <= capacityRaw ? targetRaw : capacityRaw.toString();

    if (BigInt(mintable) <= 0n) {
      await prisma.mintCycle.update({
        where: { id: cycle.id },
        data: {
          status: "skipped",
          attestedRaw: custodyRaw.toString(),
          error:
            `no un-minted reserve: custody ${fromRaw(custodyRaw, deployment.usdtDecimals)} USDT, ` +
            `supply ${fromRaw(supplyRaw, deployment.wusdtDecimals)} wUSDT`,
          completedAt: new Date(),
        },
      });
      return { chain, cycleIndex, attestedRaw: custodyRaw.toString(), mintedRaw: "0", distributedRaw: "0", mintTxId: null };
    }

    // ── Mint into the TreasuryVault's shadow reserve (real hash) ────────────
    const mint = await injectReserve(chain, mintCycleMessageId(chain, cycleIndex), mintable, {
      note: `treasury vault mint cycle #${cycleIndex}`,
    });

    // ── 25 % out to the app wallets: one bounded batch on the vault ─────────
    const appWallets = await prisma.wallet.findMany({
      where: { chain, kind: "app" },
      orderBy: { derivationIndex: "asc" },
    });

    let distributed = 0n;
    if (appWallets.length > 0) {
      // Read the reserve the vault now holds: the vault distributes 25 % of it,
      // so the ledger row records what actually moved (dust stays in the reserve).
      const reserveRaw = BigInt((await vaultStateFor(chain, deployment)).reserveRaw);
      const perWallet = BigInt(bpsOfRaw(reserveRaw.toString(), config.appWalletDistributionBps)) / BigInt(appWallets.length);
      if (perWallet > 0n) {
        await distributeReserve(
          chain,
          appWallets.map((wallet) => wallet.address),
          { note: `cycle #${cycleIndex} app-wallet distribution` },
        );
        distributed = perWallet * BigInt(appWallets.length);
      }
    }

    await prisma.mintCycle.update({
      where: { id: cycle.id },
      data: {
        attestedRaw: custodyRaw.toString(),
        mintedRaw: mintable,
        distributedRaw: distributed.toString(),
        mintTxId: mint.txId,
        status: "completed",
        completedAt: new Date(),
      },
    });

    console.log(
      `[mint] ${chain} cycle #${cycleIndex}: minted ${fromRaw(mintable, deployment.wusdtDecimals)} wUSDT, ` +
        `distributed ${fromRaw(distributed.toString(), deployment.wusdtDecimals)} — mint tx ${mint.hash}`,
    );

    return { chain, cycleIndex, attestedRaw: custodyRaw.toString(), mintedRaw: mintable, distributedRaw: distributed.toString(), mintTxId: mint.txId };
  } catch (err) {
    await prisma.mintCycle.update({
      where: { id: cycle.id },
      data: { status: "failed", error: String(err).slice(0, 400), completedAt: new Date() },
    });
    throw err;
  }
}

export async function listMintCycles() {
  const deployments = await prisma.chainDeployment.findMany();
  const cycles = await prisma.mintCycle.findMany({ orderBy: [{ chain: "asc" }, { cycleIndex: "desc" }] });

  return deployments.map((deployment) => {
    const chain = deployment.chain as ChainName;
    const cyclesForChain = cycles.filter((c) => c.chain === deployment.chain);
    const latest = cyclesForChain[0] ?? null;
    const mintedTotal = cyclesForChain
      .filter((c) => c.status === "completed")
      .reduce((acc, c) => acc + BigInt(c.mintedRaw), 0n);

    return {
      chain: deployment.chain,
      chainId: deployment.chainId,
      label: deployment.chain,
      mode: deployment.mode,
      explorerBase: deployment.explorerBase,
      decimals: deployment.wusdtDecimals,
      targetRaw: toRaw(config.treasuryVaultTargetUsd, deployment.wusdtDecimals),
      targetUsd: config.treasuryVaultTargetUsd,
      cycles: cyclesForChain.length,
      latestCycle: latest,
      mintedTotalRaw: mintedTotal.toString(),
      utilizationBps:
        BigInt(latest?.targetRaw ?? "0") > 0n
          ? Number((BigInt(latest?.mintedRaw ?? "0") * 10_000n) / BigInt(latest!.targetRaw))
          : 0,
      distributionBps: config.appWalletDistributionBps,
      chain_: chain,
    };
  });
}
