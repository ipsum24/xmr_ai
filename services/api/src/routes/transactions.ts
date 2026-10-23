import { Router } from "express";
import { asyncHandler, requireAuth } from "../http/context";
import { getTransaction, listTransactions } from "../transactions/service";
import { isChainName, type ChainName } from "../shared";

export const transactionsRouter = Router();

transactionsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const chain = typeof req.query.chain === "string" && isChainName(req.query.chain) ? (req.query.chain as ChainName) : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;

    res.json(await listTransactions({ chain, status, direction, limit }));
  }),
);

transactionsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const tx = await getTransaction(req.params.id);
    if (!tx) {
      res.status(404).json({ error: "transaction not found" });
      return;
    }
    res.json(tx);
  }),
);
