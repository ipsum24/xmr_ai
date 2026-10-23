import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { asyncHandler, requireAuth } from "../http/context";

export const webhooksRouter = Router();

webhooksRouter.get(
  "/subscriptions",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const subscriptions = await prisma.webhookSubscription.findMany({ orderBy: { createdAt: "desc" } });
    res.json(subscriptions.map(({ secret, ...rest }) => ({ ...rest, secretPreview: `${secret.slice(0, 6)}…` })));
  }),
);

webhooksRouter.post(
  "/subscriptions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ url: z.string().url(), events: z.array(z.string()).min(1) })
      .parse(req.body);

    const subscription = await prisma.webhookSubscription.create({
      data: { url: body.url, events: body.events, secret: randomBytes(24).toString("hex") },
    });
    // The signing secret is returned exactly once, at creation.
    res.json(subscription);
  }),
);

webhooksRouter.get(
  "/deliveries",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.webhookDelivery.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { subscription: { select: { url: true } } },
      }),
    );
  }),
);
