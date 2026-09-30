import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../src/db";
import type { OrderSpec } from "../../src/order-spec";
import type { VendorRow } from "../../src/vendors";
import { bankPass, type BankCashout } from "../../src/sandbox/bank";
import { SIMULATED, nextStep, simulatedQuote, stepMessage } from "../../src/sandbox/printer";

const order = { id: 42 } as OrderRow;
const vendor = { id: 7, name: "Tee Works", email: "secret@printer.example", how_to_pay: "IBAN PL00 1234" } as VendorRow;
const teeSpec: OrderSpec = { items: [{ kind: "tshirt", description: "Black tee", quantity: 60 }], artwork: [] };

describe("simulated printer shell", () => {
  it("walks the steps in order", () => {
    expect(nextStep("accepted")).toBe("proof");
    expect(nextStep("shipped")).toBeNull();
  });

  it("quotes a labelled simulated price", () => {
    const q = simulatedQuote(order, teeSpec, vendor);
    expect(q).toMatchObject({ currency: "PLN", amount: 1500 });
    expect(q!.label).toContain(SIMULATED);
    expect(simulatedQuote(order, null, vendor)).toBeNull();
  });

  it("labels step messages and never leaks contact details", () => {
    const m = stepMessage("proof", order, vendor);
    expect(m).toContain(SIMULATED);
    expect(m).toContain("order 42");
    expect(m).not.toContain(vendor.email!);
    expect(m).not.toContain(vendor.how_to_pay!);
  });
});

describe("mock bank shell", () => {
  it("is idempotent per client order id", async () => {
    const c: BankCashout = { id: 5, fiat: "EUR", amount: "88.00", clientOrderId: "co-5", status: "queued", createdAt: "2099-10-01T10:00:00Z" };
    const a = await bankPass(env, c);
    const b = await bankPass(env, c);
    const sold = (r: Awaited<ReturnType<typeof bankPass>>) => r.find((x) => "stage" in x && x.stage === "sold");
    expect(sold(a)).toBeDefined();
    expect(sold(b)).toEqual(sold(a));
    const rows = await env.DB.prepare("SELECT step FROM sandbox_bank_ledger WHERE client_order_id = 'co-5' ORDER BY step").all<{ step: string }>();
    expect(rows.results.map((r) => r.step)).toEqual(["sold", "withdrawn"]);
  });
});
