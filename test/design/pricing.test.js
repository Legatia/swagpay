import { describe, expect, it } from "vitest";
import { bandPrice, capNotice, estimate, formatEstimate, loadPricing, totalSizes } from "../../public/design/js/pricing.js";

const table = {
  tshirt: { garmentPln: 20, setupPln: 0, print: { front: [{ minQty: 1, maxQty: 49, unitPln: 17 }, { minQty: 50, maxQty: 99, unitPln: 15 }], back: [{ minQty: 1, maxQty: 99, unitPln: 15 }] } },
  sticker: { 75: [{ minQty: 1, maxQty: 1000, unitPln: 2 }] },
  banner: {},
};
const pricing = { plnPerUnit: { USD: 4, EUR: 4.3 }, fetchedAt: "2026-09-29T00:00:00Z", markupMin: 0.4, markupMax: 0.5, fxBuffer: 0.03, perOrderCapUsd: 1000 };

describe("bandPrice and totalSizes", () => {
  it("finds the band for a quantity", () => {
    expect(bandPrice(table.tshirt.print.front, 60)).toBe(15);
    expect(bandPrice(table.tshirt.print.front, 100)).toBeNull();
    expect(bandPrice(undefined, 5)).toBeNull();
  });
  it("adds up sizes, ignoring junk", () => {
    expect(totalSizes({ S: 10, M: "20", L: "abc", XL: -3 })).toBe(30);
  });
});

describe("estimate", () => {
  it("prices t-shirts from garment plus each printed side", () => {
    const r = estimate({ product: "tshirt", options: {}, sizes: { M: 60 }, printedSides: ["front"], currency: "USD" }, table, pricing);
    // cost = 60 * (20 + 15) = 2100 PLN
    expect(r).toEqual({ status: "ok", currency: "USD", low: Math.floor((2100 * 1.4 * 1.03) / 4), high: Math.ceil((2100 * 1.5 * 1.03) / 4) });
  });
  it("prices stickers by size and quantity", () => {
    const r = estimate({ product: "sticker", options: {}, sticker: { longestSideMm: 75 }, quantity: 500, printedSides: ["front"], currency: "EUR" }, table, pricing);
    expect(r).toEqual({ status: "ok", currency: "EUR", low: Math.floor((1000 * 1.4 * 1.03) / 4.3), high: Math.ceil((1000 * 1.5 * 1.03) / 4.3) });
  });
  it("adds the per-order delivery cost, like the owner's gross cost for quotes", () => {
    const r = estimate({ product: "tshirt", options: {}, sizes: { M: 60 }, printedSides: ["front"], currency: "USD" }, { ...table, deliveryPln: 60 }, pricing);
    // cost = 60 * (20 + 15) + 60 = 2160 PLN
    expect(r).toEqual({ status: "ok", currency: "USD", low: Math.floor((2160 * 1.4 * 1.03) / 4), high: Math.ceil((2160 * 1.5 * 1.03) / 4) });
  });
  it("asks the agent when there is no price data", () => {
    expect(estimate({ product: "banner", options: { size: "200x100" }, quantity: 1, printedSides: ["front"], currency: "USD" }, table, pricing)).toEqual({ status: "quote" });
    expect(estimate({ product: "tshirt", options: {}, sizes: { M: 200 }, printedSides: ["front"], currency: "USD" }, table, pricing)).toEqual({ status: "quote" });
  });
  it("asks the agent when rates are missing", () => {
    expect(estimate({ product: "tshirt", options: {}, sizes: { M: 10 }, printedSides: [], currency: "USD" }, table, null)).toEqual({ status: "quote" });
    expect(estimate({ product: "tshirt", options: {}, sizes: { M: 10 }, printedSides: [], currency: "USD" }, table, { ...pricing, plnPerUnit: null })).toEqual({ status: "quote" });
  });
  it("is empty before any quantity is entered", () => {
    expect(estimate({ product: "tshirt", options: {}, sizes: {}, printedSides: ["front"], currency: "USD" }, table, pricing)).toEqual({ status: "empty" });
  });
});

describe("capNotice", () => {
  it("warns when the high end, in USD, passes the per-order cap", () => {
    expect(capNotice({ status: "ok", currency: "USD", low: 900, high: 1001 }, pricing)).toBe("Orders over $1000 need the owner's confirmation.");
    expect(capNotice({ status: "ok", currency: "USD", low: 800, high: 1000 }, pricing)).toBeNull();
  });
  it("converts euros with plnPerUnit.EUR / plnPerUnit.USD, like send_quote", () => {
    // 940 EUR * 4.3 / 4 = 1010.5 USD
    expect(capNotice({ status: "ok", currency: "EUR", low: 800, high: 940 }, pricing)).toBe("Orders over $1000 need the owner's confirmation.");
    expect(capNotice({ status: "ok", currency: "EUR", low: 800, high: 920 }, pricing)).toBeNull();
  });
  it("says nothing without an estimate or a cap", () => {
    expect(capNotice({ status: "quote" }, pricing)).toBeNull();
    expect(capNotice({ status: "ok", currency: "USD", low: 1, high: 5000 }, { ...pricing, perOrderCapUsd: undefined })).toBeNull();
  });
});

describe("formatEstimate and loadPricing", () => {
  it("formats each status", () => {
    expect(formatEstimate({ status: "ok", currency: "USD", low: 410, high: 450 })).toBe("Estimate $410–450");
    expect(formatEstimate({ status: "ok", currency: "EUR", low: 380, high: 415 })).toBe("Estimate €380–415");
    expect(formatEstimate({ status: "quote" })).toBe("The agent will quote this");
    expect(formatEstimate({ status: "empty" })).toBe("");
  });
  it("returns null when the endpoint fails or is missing", async () => {
    expect(await loadPricing(async () => new Response("nope", { status: 404 }))).toBeNull();
    expect(await loadPricing(async () => { throw new Error("offline"); })).toBeNull();
    expect(await loadPricing(async () => Response.json(pricing))).toEqual(pricing);
  });
});
