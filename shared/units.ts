/**
 * Raw-integer accounting helpers.
 *
 * Every balance and amount that crosses the wire (API, DB, dashboard) is a raw
 * integer string in the token's smallest unit. Decimals are always taken from
 * the chain registry so BSC's 18-decimal USDT is handled correctly.
 */

export function toRaw(amount: string | number, decimals: number): string {
  const s = typeof amount === "number" ? numberToDecimalString(amount, decimals) : amount.trim();
  if (s === "" || !/^-?\d*(\.\d*)?$/.test(s) || s === "." || s === "-") {
    throw new Error(`invalid amount: ${amount}`);
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`too many decimals for a ${decimals}-decimal token: ${amount}`);
  }
  const raw = BigInt(`${intPart || "0"}${fracPart.padEnd(decimals, "0")}`).toString();
  return negative ? `-${raw}` : raw;
}

export function fromRaw(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw.toString() : raw.trim();
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, "0");
  const intPart = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${intPart}${frac ? `.${frac}` : ""}`;
}

/** Sum raw integer strings without losing precision. */
export function addRaw(...values: string[]): string {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

/** bps of a raw amount, floored — e.g. bpsOfRaw(raw, 2500) is 25%. */
export function bpsOfRaw(raw: string, bps: number): string {
  return ((BigInt(raw) * BigInt(bps)) / 10_000n).toString();
}

/** Basis points of a decimal (human) amount. */
export function applyBps(amount: number, bps: number): number {
  return (amount * bps) / 10_000;
}

function numberToDecimalString(amount: number, decimals: number): string {
  if (!Number.isFinite(amount)) throw new Error(`invalid amount: ${amount}`);
  if (Number.isInteger(amount)) return amount.toString();
  const fixed = amount.toFixed(decimals);
  return fixed;
}
