import { CHAIN_REGISTRY, type ChainName } from "@shared/chains";
import { fromRaw } from "@shared/units";

export function chainLabel(chain: string): string {
  return CHAIN_REGISTRY[chain as ChainName]?.label ?? chain;
}

export function shorten(value: string, lead = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function usd(value: number | string, maximumFractionDigits = 2): string {
  const n = typeof value === "string" ? Number(value) : value;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits });
}

export function rawToHuman(raw: string | null | undefined, decimals: number, maximumFractionDigits = 6): string {
  if (raw === null || raw === undefined) return "—";
  const human = fromRaw(raw, decimals);
  const n = Number(human);
  if (!Number.isFinite(n)) return human;
  return n.toLocaleString("en-US", { maximumFractionDigits });
}

export function rawToUsd(raw: string | null | undefined, decimals: number): string {
  if (raw === null || raw === undefined) return "—";
  return usd(fromRaw(raw, decimals));
}

export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
