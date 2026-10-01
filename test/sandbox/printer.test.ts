import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../src/db";
import type { OrderSpec } from "../../src/order-spec";
import type { VendorRow } from "../../src/vendors";
import { SIMULATED, simulatedQuote, stepDelaySeconds, stepMessage } from "../../src/sandbox/printer";

const order = { id: 42, delivery_place: "Kolektyw3, Warsaw" } as OrderRow;
const vendor = (country: string) => ({ id: 7, name: "Tee Works", city: "Warsaw", country, email: "secret@printer.example", website: "https://printer.example", how_to_pay: "IBAN PL00 1234" }) as VendorRow;
const tees = (quantity: number, printAreas?: string[]): OrderSpec => ({ items: [{ kind: "tshirt", description: "tee", quantity, printAreas }], artwork: [] });

describe("simulatedQuote", () => {
  it("floors a single tee so the order isn't dust", () => {
    const q = simulatedQuote(order, tees(1), vendor("PL"))!;
    expect(q.currency).toBe("PLN");
    expect(q.amount).toBe(2.96); // $0.75 at 3.95 PLN/USD
  });
  it("caps big orders so a full order fits the faucet", () => {
    expect(simulatedQuote(order, tees(500), vendor("PL"))!.amount).toBe(15.8); // $4.00
  });
  it("scales mid-size orders to 1% of published prices", () => {
    // 10 tees, front only: (20 + 17) × 10 + 60 delivery = 430 PLN → 4.30
    expect(simulatedQuote(order, tees(10), vendor("PL"))!.amount).toBe(4.3);
  });
  it("prices a back print as a second side", () => {
    expect(simulatedQuote(order, tees(10, ["front", "back"]), vendor("PL"))!.amount).toBe(6);
  });
  it("quotes in the printer's currency", () => {
    expect(simulatedQuote(order, tees(10), vendor("GB"))!.currency).toBe("GBP");
    expect(simulatedQuote(order, tees(10), vendor("PT"))!.currency).toBe("EUR");
    expect(simulatedQuote(order, tees(10), vendor("IN"))!.currency).toBe("INR");
    expect(simulatedQuote(order, tees(10), null)!.currency).toBe("PLN");
  });
  it("prices stickers from the published 5x5 cm table", () => {
    const spec: OrderSpec = { items: [{ kind: "sticker", description: "logo", quantity: 500 }], artwork: [] };
    // 96 + 60 = 156 PLN → 1.56 PLN = $0.39 → floored to $0.75
    expect(simulatedQuote(order, spec, vendor("PL"))!.amount).toBe(2.96);
  });
  it("is always labelled simulated and scaled", () => {
    const q = simulatedQuote(order, tees(10), vendor("PL"))!;
    expect(q.label).toContain(SIMULATED);
    expect(q.label).toContain("scaled to 1% for the testnet faucet");
    expect(simulatedQuote(order, tees(500), vendor("PL"))!.label).toContain("capped");
  });
  it("returns null without items", () => {
    expect(simulatedQuote(order, null, vendor("PL"))).toBeNull();
    expect(simulatedQuote(order, { items: [], artwork: [] }, vendor("PL"))).toBeNull();
  });
});

describe("stepMessage", () => {
  it("is labelled and never leaks contact details", () => {
    for (const step of ["accepted", "proof", "printed", "shipped"] as const) {
      const m = stepMessage(step, order, vendor("PL"));
      expect(m).toContain(SIMULATED);
      expect(m).toContain("Tee Works");
      for (const secret of ["secret@printer.example", "printer.example", "IBAN"]) expect(m).not.toContain(secret);
    }
  });
  it("says what happened at each step", () => {
    expect(stepMessage("proof", order, vendor("PL"))).toMatch(/proof/i);
    expect(stepMessage("shipped", order, null)).toMatch(/^The printer shipped/);
  });
});

describe("stepDelaySeconds", () => {
  it("keeps the fast clock", () => {
    expect(["accepted", "proof", "printed", "shipped"].map((s) => stepDelaySeconds(s as never))).toEqual([30, 60, 90, 60]);
  });
});
