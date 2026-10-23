import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { asyncHandler, requireAuth, type AuthedRequest } from "../http/context";
import { liquidateForward, swapToUsdt, unlockTransfer } from "../orchestrator/service";
import { isChainName, type ChainName } from "../shared";

export const orchestratorRouter = Router();

const chainSchema = z.string().refine(isChainName, "unknown chain");

/**
 * Every panel returns the REAL hash the node accepted. There is no route that
 * takes a hash as input — confirmations arrive on their own via the handshake
 * watcher, never before the broadcast.
 */
orchestratorRouter.post(
  "/unlock-transfer",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        walletId: z.string(),
        toExternal: z.string(),
        amountHuman: z.string().min(1),
      })
      .parse(req.body);

    const result = await unlockTransfer({
      adminId: req.admin?.id ?? null,
      chain: body.chain as ChainName,
      walletId: body.walletId,
      toExternal: body.toExternal,
      amountHuman: body.amountHuman,
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.admin?.id,
        action: "orchestrator.unlock_transfer",
        detail: JSON.stringify({ chain: body.chain, amount: body.amountHuman, hash: result.hash }),
      },
    });
    res.json(result);
  }),
);

orchestratorRouter.post(
  "/swap",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        walletId: z.string(),
        amountHuman: z.string().min(1),
        minOutHuman: z.string().min(1),
      })
      .parse(req.body);

    const result = await swapToUsdt({
      adminId: req.admin?.id ?? null,
      chain: body.chain as ChainName,
      walletId: body.walletId,
      amountHuman: body.amountHuman,
      minOutHuman: body.minOutHuman,
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.admin?.id,
        action: "orchestrator.swap",
        detail: JSON.stringify({ chain: body.chain, amount: body.amountHuman, hash: result.hash }),
      },
    });
    res.json(result);
  }),
);

orchestratorRouter.post(
  "/liquidate-forward",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        walletId: z.string(),
        toExternal: z.string(),
        amountHuman: z.string().min(1),
        slippageBps: z.number().int().min(0).max(5_000).default(50),
      })
      .parse(req.body);

    const result = await liquidateForward({
      adminId: req.admin?.id ?? null,
      chain: body.chain as ChainName,
      walletId: body.walletId,
      toExternal: body.toExternal,
      amountHuman: body.amountHuman,
      slippageBps: body.slippageBps,
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.admin?.id,
        action: "orchestrator.liquidate_forward",
        detail: JSON.stringify({ chain: body.chain, amount: body.amountHuman, hash: result.forward.hash }),
      },
    });
    res.json(result);
  }),
);
