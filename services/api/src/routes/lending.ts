import { Router } from "express";
import { z } from "zod";
import { asyncHandler, requireAuth, type AuthedRequest } from "../http/context";
import {
  liquidateLoan,
  listCollateral,
  listLoans,
  originateLoan,
  quoteLoan,
  repayLoan,
  termLadder,
} from "../lending/engine";
import { isChainName, type ChainName } from "../shared";

export const lendingRouter = Router();

const chainSchema = z.string().refine(isChainName, "unknown chain");

lendingRouter.get(
  "/terms",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(termLadder());
  }),
);

lendingRouter.get(
  "/assets",
  requireAuth,
  asyncHandler(async (req, res) => {
    const chain = z.string().refine(isChainName).parse(req.query.chain);
    res.json(await listCollateral(chain as ChainName));
  }),
);

lendingRouter.post(
  "/quote",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ chain: chainSchema, principalHuman: z.string().min(1), term: z.string(), collateralId: z.string() })
      .parse(req.body);
    res.json(await quoteLoan({ ...body, chain: body.chain as ChainName }));
  }),
);

lendingRouter.get(
  "/loans",
  requireAuth,
  asyncHandler(async (req, res) => {
    const chain = typeof req.query.chain === "string" && isChainName(req.query.chain) ? (req.query.chain as ChainName) : undefined;
    res.json(await listLoans(chain));
  }),
);

lendingRouter.post(
  "/borrow",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        chain: chainSchema,
        borrowerWalletId: z.string(),
        principalHuman: z.string().min(1),
        term: z.string(),
        collateralId: z.string(),
        collateralHuman: z.string().min(1),
      })
      .parse(req.body);

    const result = await originateLoan({ ...body, chain: body.chain as ChainName, adminId: req.admin?.id ?? null });
    res.json(result);
  }),
);

lendingRouter.post(
  "/repay",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({ loanId: z.string(), fromWalletId: z.string().optional() }).parse(req.body);
    const result = await repayLoan({ ...body, adminId: req.admin?.id ?? null });
    res.json(result);
  }),
);

lendingRouter.post(
  "/liquidate",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({ loanId: z.string() }).parse(req.body);
    const result = await liquidateLoan({ loanId: body.loanId, adminId: req.admin?.id ?? null });
    res.json(result);
  }),
);
