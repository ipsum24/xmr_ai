import { randomUUID } from "node:crypto";
import { Router } from "express";
import { keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { injectReserve, redeemWusdt, releaseReserve } from "../chains/broadcaster";
import { config } from "../config";
import { prisma } from "../db";
import { asyncHandler, requireAuth, type AuthedRequest } from "../http/context";
import { listMintCycles, runMintCycle } from "../treasury/mint-cycle";
import { mintCapacityRaw } from "../treasury/reserve";
import { vaultStates } from "../treasury/vault";
import { fromRaw, isChainName, toRaw, type ChainName } from "../shared";

export const treasuryRouter = Router();

const chainSchema = z.string().refine(isChainName, "unknown chain");

/** One-off bridge message id for an admin mint — never reused, never replayable. */
function mintMessageId(chain: ChainName): string {
  return keccak256(toUtf8Bytes(`wusdt:admin-mint:${chain}:${randomUUID()}`));
}

treasuryRouter.get(
  "/cycles",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const cycles = await listMintCycles();
    res.json(cycles);
  }),
);

/**
 * The on-chain reserve: what each chain's TreasuryVault holds, how close it is to
 * its ceiling, whether it is paused, and whether the shadow ledger still
 * reconciles with the tokens the vault actually has.
 */
treasuryRouter.get(
  "/vault",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await vaultStates(config.chainTargets));
  }),
);

/** Explicit refill: another $10M cycle, still gated on attested reserve. */
treasuryRouter.post(
  "/refill",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { chain } = z.object({ chain: chainSchema }).parse(req.body);
    const result = await runMintCycle(chain as ChainName);
    await prisma.auditLog.create({
      data: { adminId: req.admin?.id, action: "treasury.refill", detail: `${chain}:${result.cycleIndex}` },
    });
    res.json(result);
  }),
);

/** Admin mint: same reserve gate as the automatic cycle. */
treasuryRouter.post(
  "/mint",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        amountHuman: z.string().min(1),
        toWalletId: z.string().optional(),
      })
      .parse(req.body);
    const chain = body.chain as ChainName;

    const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
    if (!deployment) throw new Error(`chain ${chain} is not configured`);

    const treasury = await prisma.wallet.findFirst({ where: { chain, kind: "treasury" } });
    if (!treasury) throw new Error("treasury wallet missing");

    const destination = body.toWalletId
      ? await prisma.wallet.findUniqueOrThrow({ where: { id: body.toWalletId } })
      : treasury;

    const amountRaw = toRaw(body.amountHuman, deployment.wusdtDecimals);
    const { capacityRaw, custodyRaw, supplyRaw } = await mintCapacityRaw({
      chain,
      wusdt: deployment.wusdt,
      usdt: deployment.usdt,
      custodyAddress: treasury.address,
    });

    if (BigInt(amountRaw) > capacityRaw) {
      throw new Error(
        `ReserveBackingExceeded: ${body.amountHuman} wUSDT requested, capacity is ` +
          `${fromRaw(capacityRaw, deployment.wusdtDecimals)} ` +
          `(custody ${fromRaw(custodyRaw, deployment.usdtDecimals)} USDT, supply ${fromRaw(supplyRaw, deployment.wusdtDecimals)} wUSDT)`,
      );
    }

    // Supply is only ever created inside the vault, against a one-off message id.
    // Naming a destination wallet funds it with an explicit release out of the
    // reserve; otherwise the minted amount stays in the reserve.
    const result = await injectReserve(chain, mintMessageId(chain), amountRaw, {
      adminId: req.admin?.id ?? null,
      note: body.toWalletId ? `admin mint → ${destination.label}` : "admin mint (reserve)",
    });
    const release = body.toWalletId
      ? await releaseReserve(chain, destination.address, amountRaw, {
          adminId: req.admin?.id ?? null,
          note: `admin mint → ${destination.label}`,
        })
      : null;

    await prisma.auditLog.create({
      data: { adminId: req.admin?.id, action: "treasury.mint", detail: `${chain}:${result.amountHuman}` },
    });
    res.json({ ...result, releaseTxHash: release?.hash ?? null });
  }),
);

treasuryRouter.post(
  "/burn",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({ chain: chainSchema, walletId: z.string(), amountHuman: z.string().min(1) })
      .parse(req.body);
    const chain = body.chain as ChainName;
    const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
    if (!deployment) throw new Error(`chain ${chain} is not configured`);

    // Redemption: the wallet burns and emits a request id, the vault's operator
    // confirms it so the reserve drops with the release.
    const result = await redeemWusdt(chain, body.walletId, toRaw(body.amountHuman, deployment.wusdtDecimals), {
      adminId: req.admin?.id ?? null,
      note: "admin redemption",
    });
    await prisma.auditLog.create({
      data: { adminId: req.admin?.id, action: "treasury.burn", detail: `${body.chain}:${body.amountHuman}` },
    });
    res.json(result);
  }),
);
