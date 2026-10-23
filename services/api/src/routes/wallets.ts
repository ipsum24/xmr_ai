import { Router } from "express";
import { z } from "zod";
import { transferToken } from "../chains/broadcaster";
import { prisma } from "../db";
import { asyncHandler, requireAuth, type AuthedRequest } from "../http/context";
import { fromRaw, isChainName, toRaw, type ChainName } from "../shared";

export const walletsRouter = Router();

const chainSchema = z.string().refine(isChainName, "unknown chain");

walletsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const chain = typeof req.query.chain === "string" && isChainName(req.query.chain) ? req.query.chain : undefined;
    const wallets = await prisma.wallet.findMany({
      where: chain ? { chain } : {},
      include: { balances: true },
      orderBy: [{ chain: "asc" }, { derivationIndex: "asc" }],
    });

    res.json(
      wallets.map((wallet) => ({
        id: wallet.id,
        chain: wallet.chain,
        address: wallet.address,
        label: wallet.label,
        kind: wallet.kind,
        balances: wallet.balances.map((b) => ({
          tokenId: b.tokenId,
          symbol: b.symbol,
          decimals: b.decimals,
          availableRaw: b.available,
          availableHuman: fromRaw(b.available, b.decimals),
        })),
      })),
    );
  }),
);

walletsRouter.post(
  "/transfer",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        token: z.enum(["wusdt", "usdt"]),
        walletId: z.string(),
        toAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address"),
        amountHuman: z.string().min(1),
      })
      .parse(req.body);

    const chain = body.chain as ChainName;
    const deployment = await prisma.chainDeployment.findUnique({ where: { chain } });
    if (!deployment) throw new Error(`chain ${chain} is not configured`);

    const decimals = body.token === "wusdt" ? deployment.wusdtDecimals : deployment.usdtDecimals;
    const result = await transferToken(chain, body.token, body.walletId, body.toAddress, toRaw(body.amountHuman, decimals), {
      adminId: req.admin?.id ?? null,
      note: "console transfer-out",
    });

    await prisma.auditLog.create({
      data: { adminId: req.admin?.id, action: "wallets.transfer", detail: `${chain}:${result.amountHuman} ${result.tokenSymbol}` },
    });
    res.json(result);
  }),
);
