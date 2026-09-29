import { businessDaysBetween } from "./time";

export type PrintMethod = "screen" | "dtf" | "dtg" | "diecut";

export type Verdict =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "escalate"; reason: string };

export interface Policy {
  allowedItems: Record<string, PrintMethod[]>;
  markupMin: number;
  markupMax: number;
  perOrderCapUsd: number;
  fxBuffer: number;
  quoteValidityHours: number;
  minLeadBusinessDays: Record<PrintMethod, number>;
}

export const DEFAULT_POLICY: Policy = {
  allowedItems: { tshirt: ["screen", "dtf", "dtg"], sticker: ["diecut"] },
  markupMin: 0.4,
  markupMax: 0.5,
  perOrderCapUsd: 1000,
  fxBuffer: 0.03,
  quoteValidityHours: 48,
  minLeadBusinessDays: { screen: 4, dtf: 2, dtg: 2, diecut: 2 },
};

const ALLOW: Verdict = { kind: "allow" };
const EPS = 1e-9;

export function loadPolicy(vars: Record<string, unknown>): Policy {
  const num = (key: string, fallback: number): number => {
    const raw = vars[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${String(raw)}"`);
    return n;
  };
  const p: Policy = {
    ...DEFAULT_POLICY,
    markupMin: num("POLICY_MARKUP_MIN", DEFAULT_POLICY.markupMin),
    markupMax: num("POLICY_MARKUP_MAX", DEFAULT_POLICY.markupMax),
    perOrderCapUsd: num("POLICY_PER_ORDER_CAP_USD", DEFAULT_POLICY.perOrderCapUsd),
    fxBuffer: num("POLICY_FX_BUFFER", DEFAULT_POLICY.fxBuffer),
    quoteValidityHours: num("POLICY_QUOTE_VALIDITY_HOURS", DEFAULT_POLICY.quoteValidityHours),
  };
  if (p.markupMin > p.markupMax) throw new Error("POLICY_MARKUP_MIN must not exceed POLICY_MARKUP_MAX");
  return p;
}

export function checkItem(item: { kind: string; method?: string }, p: Policy): Verdict {
  const methods = p.allowedItems[item.kind];
  if (!methods) return { kind: "escalate", reason: `"${item.kind}" is not on the item list; the owner must approve it` };
  if (item.method !== undefined && !methods.includes(item.method as PrintMethod)) {
    return { kind: "block", reason: `${item.kind} is printed with ${methods.join(", ")}, not "${item.method}"` };
  }
  return ALLOW;
}

export interface QuoteInput {
  price: number;
  currency: "USD" | "EUR";
  costPln: number;
  /** PLN per 1 unit of the quote currency, e.g. 3.70 PLN per USD. */
  plnPerUnit: number;
  /** USD per 1 unit of the quote currency (1 for USD). */
  usdPerUnit: number;
}

/** Printer cost in the quote currency, with the FX buffer added. */
export function quoteCostBasis(q: QuoteInput, p: Policy): number {
  return (q.costPln / q.plnPerUnit) * (1 + p.fxBuffer);
}

/** Deposit: the larger of half the price and the printer cost, rounded up to the cent, never above the price. */
export function depositFor(q: QuoteInput, p: Policy): number {
  const raw = Math.max(q.price * 0.5, quoteCostBasis(q, p));
  return Math.min(q.price, Math.ceil(raw * 100 - EPS) / 100);
}

export function checkQuote(q: QuoteInput, p: Policy): { verdict: Verdict; markup: number } {
  if (!(q.price > 0 && q.costPln > 0 && q.plnPerUnit > 0 && q.usdPerUnit > 0)) {
    return { verdict: { kind: "block", reason: "price, cost and rates must all be positive" }, markup: NaN };
  }
  const costBasis = quoteCostBasis(q, p);
  const markup = q.price / costBasis - 1;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (markup < p.markupMin - EPS || markup > p.markupMax + EPS) {
    return {
      verdict: { kind: "block", reason: `markup ${pct(markup)} is outside ${pct(p.markupMin)}-${pct(p.markupMax)}` },
      markup,
    };
  }
  const priceUsd = q.price * q.usdPerUnit;
  if (priceUsd > p.perOrderCapUsd + EPS) {
    return {
      verdict: { kind: "escalate", reason: `${priceUsd.toFixed(2)} USD is above the ${p.perOrderCapUsd} USD per-order cap` },
      markup,
    };
  }
  return { verdict: ALLOW, markup };
}

export function checkLeadTime(now: Date, deadline: Date, method: PrintMethod, p: Policy): Verdict {
  if (deadline.getTime() <= now.getTime()) return { kind: "block", reason: "the deadline has passed" };
  const days = businessDaysBetween(now, deadline);
  const min = p.minLeadBusinessDays[method];
  if (days < min) {
    return { kind: "escalate", reason: `only ${days} business days before the deadline; ${method} needs ${min}` };
  }
  return ALLOW;
}

export function checkPrinterChoice(printer: { jobsDone: number }): Verdict {
  return printer.jobsDone === 0 ? { kind: "escalate", reason: "first job with this printer" } : ALLOW;
}

export function printerPaymentVerdict(): Verdict {
  return { kind: "escalate", reason: "the owner pays every printer" };
}

export function refundVerdict(): Verdict {
  return { kind: "escalate", reason: "the owner sends every refund" };
}

export function quoteStillValid(
  quote: { issuedAt: Date; plnPerUnit: number },
  now: Date,
  plnPerUnitNow: number,
  p: Policy,
): boolean {
  const ageHours = (now.getTime() - quote.issuedAt.getTime()) / 3_600_000;
  if (ageHours > p.quoteValidityHours) return false;
  // Fewer PLN per unit means the PLN cost got dearer in the quote currency.
  const costRise = quote.plnPerUnit / plnPerUnitNow - 1;
  return costRise <= p.fxBuffer + EPS;
}
