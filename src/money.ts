export type Currency = "USD" | "EUR";
export type Token = "USDC" | "EURC";

export const TOKEN_FOR: Record<Currency, Token> = { USD: "USDC", EUR: "EURC" };

/** Token amounts are integers with 6 decimals, so one cent is 10,000 units. */
export const UNITS_PER_CENT = 10_000;
export const MAX_TAG = 9_999;

/** The payable amount: whole cents, then a tag in the last four of six decimals (412.37 with tag 42 is 412.370042). */
export function taggedUnits(cents: number, tag: number): number {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`cents must be a positive integer, got ${cents}`);
  if (!Number.isInteger(tag) || tag < 1 || tag > MAX_TAG) throw new Error(`tag must be 1-${MAX_TAG}, got ${tag}`);
  return cents * UNITS_PER_CENT + tag;
}

export function tagOf(units: number): number {
  return units % UNITS_PER_CENT;
}

/** 412370042 → "412.370042" */
export function formatUnits(units: number): string {
  const abs = Math.abs(units);
  return `${units < 0 ? "-" : ""}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, "0")}`;
}

/** 41237 → "412.37" */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}
