/**
 * Lending terms — the platform's fixed-term, fixed-rate book.
 *
 * These numbers are the contract's `LendingTerms.quote()`: simple interest over
 * the fixed term, APR locked at origination. The dashboard and the API both use
 * this module so a quote can never disagree between UI and backend.
 *
 * Rate ladder is priced against the market (Oct 2026): Aave v3 USDT borrow
 * ≈ 4.3 %, Morpho ≈ 2.7–4.2 %, Fluid ≈ 8–8.6 %. 3.5 % → 6 % → 10 % → 15 % is
 * competitive short-term and at the top of market at 12 months.
 */

import { toRaw } from "./units";

export type TermKey = "MONTH_1" | "MONTH_3" | "MONTH_6" | "MONTH_12";

export interface TermTier {
  readonly days: number;
  readonly aprBps: number;
  readonly label: string;
}

export const TERM_TIERS: Record<TermKey, TermTier> = {
  MONTH_1: { days: 30, aprBps: 350, label: "1 month" },
  MONTH_3: { days: 90, aprBps: 600, label: "3 months" },
  MONTH_6: { days: 180, aprBps: 1_000, label: "6 months" },
  MONTH_12: { days: 365, aprBps: 1_500, label: "12 months" },
};

export const TERM_KEYS = Object.keys(TERM_TIERS) as TermKey[];

/** Hard ceiling on origination LTV; per-asset LTV is lower. */
export const MAX_LTV_BPS = 7_000;
/** Keeper incentive on a liquidation. */
export const LIQUIDATION_INCENTIVE_BPS = 500;
export const GRACE_PERIOD_DAYS = 7;

export function isTermKey(value: string): value is TermKey {
  return Object.prototype.hasOwnProperty.call(TERM_TIERS, value);
}

/** Fixed-term simple interest on a raw principal — mirrors `LendingTerms.quote`. */
export function quoteInterestRaw(principalRaw: string, term: TermKey): string {
  const tier = TERM_TIERS[term];
  return (
    (BigInt(principalRaw) * BigInt(tier.aprBps) * BigInt(tier.days)) / (10_000n * 365n)
  ).toString();
}

export function totalRepayRaw(principalRaw: string, term: TermKey): string {
  return (BigInt(principalRaw) + BigInt(quoteInterestRaw(principalRaw, term))).toString();
}

/**
 * Collateral required for a principal, in the collateral token's raw units.
 *
 * effective LTV = max LTV × (1 − haircut), and the required collateral is
 * principal / (effective LTV × price).
 */
export function requiredCollateralRaw(params: {
  principalRaw: string;
  priceRaw8: string;
  haircutBps: number;
  ltvBps: number;
  collateralDecimals: number;
}): string {
  const { principalRaw, priceRaw8, haircutBps, ltvBps, collateralDecimals } = params;
  const effectiveLtvBps = (ltvBps * (10_000 - haircutBps)) / 10_000;
  if (effectiveLtvBps <= 0) throw new Error("effective LTV is zero");
  // collateral = principal / (price × effLtv), kept in raw integers:
  // principalRaw (usdDec) × 10^collDec × 10^8 / (effLtvBps × priceRaw8 × 10^usdDec)
  const scale = 10n ** BigInt(collateralDecimals);
  const numerator = BigInt(principalRaw) * scale * 100_000_000n;
  const denominator = BigInt(effectiveLtvBps) * BigInt(priceRaw8);
  return (numerator / denominator).toString();
}

/** Effective APR actually paid over the term, in percent. */
export function effectiveAprPct(principalRaw: string, term: TermKey): number {
  const tier = TERM_TIERS[term];
  return (tier.aprBps / 100) * (365 / tier.days) * 1;
}

export function requiredCollateralForUsd(usd: number, term: TermKey, asset: { priceRaw8: string; haircutBps: number; ltvBps: number }) {
  return Number(
    requiredCollateralRaw({
      principalRaw: toRaw(usd, 6),
      priceRaw8: asset.priceRaw8,
      haircutBps: asset.haircutBps,
      ltvBps: asset.ltvBps,
      collateralDecimals: 18,
    }),
  );
}
