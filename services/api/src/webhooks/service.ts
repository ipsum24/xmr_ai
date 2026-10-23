import { createHmac } from "node:crypto";
import { prisma } from "../db";

export interface WebhookableTransaction {
  id: string;
  chain: string;
  direction: string;
  status: string;
  hash: string | null;
  amount: string;
  tokenSymbol: string;
  fromAddress: string;
  toAddress: string;
  explorerUrl: string | null;
}

/**
 * Receipt webhooks: on confirmation each active subscription gets a signed
 * delivery (HMAC-SHA256 over the raw body in `x-wusdt-signature`). Delivery
 * attempts are recorded in a ledger so a client can audit what was sent.
 * With no subscriptions registered nothing is delivered — as in this build.
 */
export async function queueReceiptWebhooks(tx: WebhookableTransaction): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { active: true, events: { has: "tx.confirmed" } },
  });
  if (subscriptions.length === 0) return;

  const payload = {
    event: "tx.confirmed",
    transaction: {
      id: tx.id,
      chain: tx.chain,
      direction: tx.direction,
      status: tx.status,
      hash: tx.hash,
      amount: tx.amount,
      token: tx.tokenSymbol,
      from: tx.fromAddress,
      to: tx.toAddress,
      explorerUrl: tx.explorerUrl,
    },
  };
  const body = JSON.stringify(payload);

  for (const subscription of subscriptions) {
    const delivery = await prisma.webhookDelivery.create({
      data: { subscriptionId: subscription.id, transactionId: tx.id, event: "tx.confirmed" },
    });
    void deliver(subscription.id, subscription.url, subscription.secret, body, delivery.id);
  }
}

async function deliver(
  subscriptionId: string,
  url: string,
  secret: string,
  body: string,
  deliveryId: string,
): Promise<void> {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wusdt-signature": `sha256=${signature}`,
        "x-wusdt-event": "tx.confirmed",
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: response.ok ? "delivered" : "failed",
        attempts: 1,
        responseCode: response.status,
        deliveredAt: response.ok ? new Date() : null,
        error: response.ok ? null : `HTTP ${response.status}`,
      },
    });
  } catch (err) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "failed", attempts: 1, error: String(err).slice(0, 300) },
    });
  }
  void subscriptionId;
}
