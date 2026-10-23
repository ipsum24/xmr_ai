/**
 * Seed: the admin account and the approved collateral registry.
 * Idempotent — safe to run on every boot.
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { config } from "../src/config";
import { CHAIN_NAMES } from "../../../shared/chains";

const prisma = new PrismaClient();
const ALL_CHAINS = CHAIN_NAMES as string[];

/** Approved collateral (price in 8-decimal raw units, haircut/LTV in bps). */
const COLLATERAL = [
  { address: "0xBTC0000000000000000000000000000000000btc", symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8, priceRaw8: "6800000000000", haircutBps: 2000, ltvBps: 7000 },
  { address: "0xETH0000000000000000000000000000000000eth", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceRaw8: "400000000000", haircutBps: 2000, ltvBps: 7000 },
  { address: "0xWUSDT000000000000000000000000000000000", symbol: "wUSDT", name: "Wrapped USDT (platform)", decimals: 6, priceRaw8: "100000000", haircutBps: 500, ltvBps: 9000 },
  { address: "0xRWA0000000000000000000000000000000000rwa", symbol: "tRWA", name: "Tokenised T-bill (RWA)", decimals: 6, priceRaw8: "100500000", haircutBps: 800, ltvBps: 8500 },
];

async function main() {
  const email = config.adminEmail.toLowerCase();
  const passwordHash = await bcrypt.hash(config.adminInitialPassword, 10);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {},
    create: { email, name: "Platform Admin", passwordHash },
  });
  if (process.env.NODE_ENV !== "production") {
    console.log(`[seed] admin ready: ${admin.email}`);
  }

  for (const chain of ALL_CHAINS) {
    for (const asset of COLLATERAL) {
      await prisma.collateralAsset.upsert({
        where: { chain_address: { chain, address: asset.address } },
        update: {
          priceRaw8: asset.priceRaw8,
          haircutBps: asset.haircutBps,
          ltvBps: asset.ltvBps,
        },
        create: { chain, ...asset },
      });
    }
  }
  console.log(`[seed] collateral registry ready on ${ALL_CHAINS.length} chains`);
}

main()
  .catch((err) => {
    console.error("[seed] failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
