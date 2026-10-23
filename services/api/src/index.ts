import cookieParser from "cookie-parser";
import express from "express";
import { bootstrapChains } from "./chains/devnet";
import { startHandshakeWatcher } from "./chains/handshake";
import { assertRuntimeMode, config } from "./config";
import { prisma } from "./db";
import { errorHandler } from "./http/context";
import { sweepLiquidatableLoans } from "./lending/engine";
import { authRouter } from "./routes/auth";
import { chainsRouter } from "./routes/chains";
import { lendingRouter } from "./routes/lending";
import { orchestratorRouter } from "./routes/orchestrator";
import { transactionsRouter } from "./routes/transactions";
import { treasuryRouter } from "./routes/treasury";
import { walletsRouter } from "./routes/wallets";
import { webhooksRouter } from "./routes/webhooks";
import { runStartupMintCycles } from "./treasury/mint-cycle";

async function main(): Promise<void> {
  assertRuntimeMode();

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/", (_req, res) => {
    res.json({
      name: "wUSDT platform API",
      mode: config.chainMode,
      chains: config.chainTargets,
      time: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/chains", chainsRouter);
  app.use("/api/treasury", treasuryRouter);
  app.use("/api/wallets", walletsRouter);
  app.use("/api/orchestrator", orchestratorRouter);
  app.use("/api/transactions", transactionsRouter);
  app.use("/api/lending", lendingRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use(errorHandler);

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`[api] listening on 0.0.0.0:${config.port} (${config.chainMode} mode)`);
  });

  startHandshakeWatcher();

  // Boot work happens after the server is listening so the console is reachable
  // immediately: bring the chains up, then run the autonomous mint cycle.
  void (async () => {
    await bootstrapChains();
    await runStartupMintCycles();
  })();

  const sweep = setInterval(() => {
    void sweepLiquidatableLoans().catch((err) => console.error("[lending] sweep failed", err));
  }, 60_000);
  sweep.unref();

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});
