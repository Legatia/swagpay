import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY, checkItem, checkLeadTime, checkPrinterChoice, checkQuote, depositFor, loadPolicy,
  printerPaymentVerdict, quoteStillValid, refundVerdict, PrintMethod,
} from "../src/policy";

const p = DEFAULT_POLICY;

describe("policy", () => {
  it("allows t-shirts and stickers with their methods", () => {
    expect(checkItem({ kind: "tshirt", method: "screen" }, p)).toEqual({ kind: "allow" });
    expect(checkItem({ kind: "sticker", method: "diecut" }, p)).toEqual({ kind: "allow" });
    expect(checkItem({ kind: "tshirt" }, p)).toEqual({ kind: "allow" });
  });

  it("escalates items not on the list and blocks wrong methods", () => {
    expect(checkItem({ kind: "banner" }, p).kind).toBe("escalate");
    expect(checkItem({ kind: "sticker", method: "screen" }, p).kind).toBe("block");
  });

  it("computes markup on the PLN cost plus the FX buffer", () => {
    // 1000 PLN at 3.70 PLN per USD, +3% buffer => cost basis 278.38 USD; 400 USD => 43.7%
    const { verdict, markup } = checkQuote({ price: 400, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p);
    expect(verdict).toEqual({ kind: "allow" });
    expect(markup).toBeCloseTo(0.4369, 3);
  });

  it("blocks quotes outside the markup band", () => {
    expect(checkQuote({ price: 300, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p).verdict.kind).toBe("block");
    expect(checkQuote({ price: 450, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p).verdict.kind).toBe("block");
  });

  it("escalates quotes above the per-order cap, converting EUR to USD", () => {
    // 3000 PLN at 4.25 PLN per EUR, +3% => 727.06 EUR; 1050 EUR is 44.4% markup, 1050 EUR * 1.15 = 1207.5 USD
    const r = checkQuote({ price: 1050, currency: "EUR", costPln: 3000, plnPerUnit: 4.25, usdPerUnit: 1.15 }, p);
    expect(r.verdict.kind).toBe("escalate");
  });

  it("blocks nonsense quote inputs", () => {
    expect(checkQuote({ price: 0, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p).verdict.kind).toBe("block");
    expect(checkQuote({ price: 400, currency: "USD", costPln: -1, plnPerUnit: 3.7, usdPerUnit: 1 }, p).verdict.kind).toBe("block");
  });

  it("sets the deposit to the larger of half the price and the printer cost", () => {
    // cost basis 1000 / 3.7 * 1.03 = 278.378... USD, above half of 400
    expect(depositFor({ price: 400, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p)).toBe(278.38);
    // cost basis 139.19 USD, below half of 400
    expect(depositFor({ price: 400, currency: "USD", costPln: 500, plnPerUnit: 3.7, usdPerUnit: 1 }, p)).toBe(200);
    // never more than the price itself
    expect(depositFor({ price: 100, currency: "USD", costPln: 1000, plnPerUnit: 3.7, usdPerUnit: 1 }, p)).toBe(100);
  });

  it("escalates deadlines shorter than the method's lead time and blocks past ones", () => {
    const monday = new Date("2026-10-05T08:00:00Z");
    const thursday = new Date("2026-10-08T15:00:00Z"); // 2 business days
    expect(checkLeadTime(monday, thursday, "diecut", p)).toEqual({ kind: "allow" });
    expect(checkLeadTime(monday, thursday, "screen", p).kind).toBe("escalate");
    expect(checkLeadTime(monday, new Date("2026-10-04T08:00:00Z"), "dtf", p).kind).toBe("block");
  });

  it("escalates a first job with a printer, every printer payment and every refund", () => {
    expect(checkPrinterChoice({ jobsDone: 0 }).kind).toBe("escalate");
    expect(checkPrinterChoice({ jobsDone: 3 })).toEqual({ kind: "allow" });
    expect(printerPaymentVerdict().kind).toBe("escalate");
    expect(refundVerdict().kind).toBe("escalate");
  });

  it("expires quotes on age or when the zloty strengthens past the buffer", () => {
    const issuedAt = new Date("2026-10-05T08:00:00Z");
    expect(quoteStillValid({ issuedAt, plnPerUnit: 3.7 }, new Date("2026-10-06T08:00:00Z"), 3.65, p)).toBe(true);
    expect(quoteStillValid({ issuedAt, plnPerUnit: 3.7 }, new Date("2026-10-07T09:00:00Z"), 3.7, p)).toBe(false); // 49 h
    expect(quoteStillValid({ issuedAt, plnPerUnit: 3.7 }, new Date("2026-10-05T12:00:00Z"), 3.55, p)).toBe(false); // +4.2%
  });

  it("reads overrides from vars and rejects bad ones", () => {
    expect(loadPolicy({ POLICY_PER_ORDER_CAP_USD: "1500" }).perOrderCapUsd).toBe(1500);
    expect(loadPolicy({}).markupMin).toBe(0.4);
    expect(() => loadPolicy({ POLICY_FX_BUFFER: "abc" })).toThrow();
    expect(() => loadPolicy({ POLICY_MARKUP_MIN: "0.6" })).toThrow();
  });

  it("rejects Object.prototype names in checkItem without throwing", () => {
    expect(checkItem({ kind: "constructor" }, p).kind).toBe("escalate");
    expect(checkItem({ kind: "toString", method: "screen" }, p).kind).toBe("escalate");
  });

  it("rejects unknown print methods in checkLeadTime", () => {
    const monday = new Date("2026-10-05T08:00:00Z");
    const thursday = new Date("2026-10-08T15:00:00Z");
    expect(checkLeadTime(monday, thursday, "constructor" as PrintMethod, p)).toEqual({ kind: "block", reason: `unknown print method "constructor"` });
    expect(checkLeadTime(monday, thursday, "banner" as PrintMethod, p)).toEqual({ kind: "block", reason: `unknown print method "banner"` });
  });
});
