/**
 * Single import surface for the API.
 *
 * Explicit named re-exports (rather than `export *` barrels): under Node's ESM
 * linker a chained star re-export of TypeScript sources does not reliably expose
 * the names, and this keeps the module graph unambiguous for tsx and tsc alike.
 */
import {
  CHAIN_NAMES,
  CHAIN_REGISTRY,
  CONFIRMATIONS,
  chainConfig,
  isChainName,
  type ChainConfig,
  type ChainFamily,
  type ChainName,
} from "../../../shared/chains";
import {
  EXPLORERS,
  addressLink,
  explorerUrlFor,
  tokenLink,
  txLink,
  type ExplorerLinks,
} from "../../../shared/explorers";
import { addRaw, applyBps, bpsOfRaw, fromRaw, toRaw } from "../../../shared/units";
import {
  GRACE_PERIOD_DAYS,
  LIQUIDATION_INCENTIVE_BPS,
  MAX_LTV_BPS,
  TERM_KEYS,
  TERM_TIERS,
  effectiveAprPct,
  isTermKey,
  quoteInterestRaw,
  requiredCollateralForUsd,
  requiredCollateralRaw,
  totalRepayRaw,
  type TermKey,
  type TermTier,
} from "../../../shared/lending";

export {
  CHAIN_NAMES,
  CHAIN_REGISTRY,
  CONFIRMATIONS,
  chainConfig,
  isChainName,
  EXPLORERS,
  addressLink,
  explorerUrlFor,
  tokenLink,
  txLink,
  addRaw,
  applyBps,
  bpsOfRaw,
  fromRaw,
  toRaw,
  GRACE_PERIOD_DAYS,
  LIQUIDATION_INCENTIVE_BPS,
  MAX_LTV_BPS,
  TERM_KEYS,
  TERM_TIERS,
  effectiveAprPct,
  isTermKey,
  quoteInterestRaw,
  requiredCollateralForUsd,
  requiredCollateralRaw,
  totalRepayRaw,
};

export type { ChainConfig, ChainFamily, ChainName, ExplorerLinks, TermKey, TermTier };
