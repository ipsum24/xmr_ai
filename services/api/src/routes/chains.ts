import { Router } from "express";
import { config } from "../config";
import { prisma } from "../db";
import { CHAIN_REGISTRY, fromRaw, type ChainName } from "../shared";
import { asyncHandler, requireAuth } from "../http/context";
import { mintCapacityRaw } from "../treasury/reserve";

export const chainsRouter = Router();

/** Chain fleet as the console needs it: deployment, custody, reserve capacity. */
chainsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const deployments = await prisma.chainDeployment.findMany({ orderBy: { chain: "asc" } });
    const wallets = await prisma.wallet.findMany({ include: { balances: true }, orderBy: { derivationIndex: "asc" } });

    const chains = await Promise.all(
      deployments.map(async (deployment) => {
        const chain = deployment.chain as ChainName;
        const registry = CHAIN_REGISTRY[chain];
        const chainWallets = wallets.filter((w) => w.chain === deployment.chain);
        const treasury = chainWallets.find((w) => w.kind === "treasury");

        let capacityRaw: string | null = null;
        let custodyRaw: string | null = null;
        let supplyRaw: string | null = null;
        try {
          const capacity = await mintCapacityRaw({
            chain,
            wusdt: deployment.wusdt,
            usdt: deployment.usdt,
            custodyAddress: treasury?.address ?? deployment.governor,
          });
          capacityRaw = capacity.capacityRaw.toString();
          custodyRaw = capacity.custodyRaw.toString();
          supplyRaw = capacity.supplyRaw.toString();
        } catch {
          capacityRaw = null; // chain temporarily unreachable — console shows it as such
        }

        return {
          chain: deployment.chain,
          label: registry.label,
          chainId: deployment.chainId,
          family: registry.family,
          mode: deployment.mode,
          status: capacityRaw === null ? "awaiting_rpc" : "ready",
          rpcUrl: config.chainMode === "devnet" ? deployment.rpcUrl : undefined,
          usdt: deployment.usdt,
          usdtDecimals: deployment.usdtDecimals,
          wusdt: deployment.wusdt,
          dexRouter: deployment.dexRouter,
          dexName: deployment.dexName,
          explorerBase: deployment.explorerBase,
          usdtHuman: registry.usdtDecimals === 18 ? "18 decimals" : "6 decimals",
          reserve: {
            custodyRaw,
            supplyRaw,
            capacityRaw,
            custodyHuman:
              custodyRaw && deployment.usdtDecimals ? fromRaw(custodyRaw, deployment.usdtDecimals) : null,
            supplyHuman: supplyRaw ? fromRaw(supplyRaw, deployment.wusdtDecimals) : null,
            capacityHuman: capacityRaw ? fromRaw(capacityRaw, deployment.wusdtDecimals) : null,
          },
          wallets: chainWallets.map((w) => ({
            id: w.id,
            address: w.address,
            label: w.label,
            kind: w.kind,
            balances: w.balances.map((b) => ({
              tokenId: b.tokenId,
              symbol: b.symbol,
              decimals: b.decimals,
              availableRaw: b.available,
              availableHuman: fromRaw(b.available, b.decimals),
            })),
          })),
        };
      }),
    );

    res.json({ mode: config.chainMode, targets: config.chainTargets, chains });
  }),
);
