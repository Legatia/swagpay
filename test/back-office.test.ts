import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cashoutAmount, createSupplierPayment, getSupplierPayment, latestCashout, liveCashouts, logAdminAction, queueCashout,
  recordCashoutFailed, recordCashoutSold, recordCashoutWithdrawn, recordWithdrawError, retryWithdrawal, runnerLastSeen,
  setSupplierPaymentStatus, supplierPaymentForOrder, touchRunner,
} from "../src/back-office";
import { newOrderRow } from "./fixtures";

const sp = async (currency = "PLN", amountCents = 100_000) => {
  const { order } = await newOrderRow();
  return createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency, amountCents });
};

describe("supplier payments", () => {
  it("creates one per order; a repeat returns the first", async () => {
    const a = await sp();
    const again = await createSupplierPayment(env.DB, { orderId: a.order_id, vendorId: null, currency: "EUR", amountCents: 5 });
    expect(again).toMatchObject({ id: a.id, currency: "PLN", amount_cents: 100_000, status: "due" });
    expect((await supplierPaymentForOrder(env.DB, a.order_id))?.id).toBe(a.id);
  });

  it("moves only from the expected statuses, recording how it was paid", async () => {
    const a = await sp();
    expect(await setSupplierPaymentStatus(env.DB, a.id, ["ready"], "paid")).toBe(false);
    expect(await setSupplierPaymentStatus(env.DB, a.id, ["due"], "paid", { method: "blik", reference: "BLIK 123", paidAt: "2099-10-02T10:00:00.000Z" })).toBe(true);
    expect(await getSupplierPayment(env.DB, a.id)).toMatchObject({ status: "paid", method: "blik", reference: "BLIK 123", paid_at: "2099-10-02T10:00:00.000Z" });
  });
});

describe("cash-outs", () => {
  it("queues one live cash-out and moves the payment to cashing_out", async () => {
    const a = await sp();
    const c = (await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 23_721 }))!;
    expect(c).toMatchObject({ supplier_payment_id: a.id, fiat: "EUR", fiat_cents: 23_721, status: "queued", withdraw_attempts: 0 });
    expect(c.client_order_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getSupplierPayment(env.DB, a.id))?.status).toBe("cashing_out");
    expect(await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 1 })).toBeNull();
    expect((await liveCashouts(env.DB)).some((x) => x.id === c.id)).toBe(true);
  });

  it("sold then withdrawn makes the payment ready; a late or repeated result changes nothing", async () => {
    const a = await sp();
    const c = (await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 10_000 }))!;
    expect(await recordCashoutWithdrawn(env.DB, c.id, { withdrawalRef: "W1", feeCents: 100 })).toBeNull();
    expect(await recordCashoutSold(env.DB, c.id, { orderRef: "O1", soldUnits: 102_100_000 })).toMatchObject({ status: "sold", order_ref: "O1", sold_units: 102_100_000 });
    expect(await recordCashoutSold(env.DB, c.id, { orderRef: "O2", soldUnits: 1 })).toBeNull();
    expect(await recordCashoutWithdrawn(env.DB, c.id, { withdrawalRef: "W1", feeCents: 100 })).toMatchObject({ status: "withdrawn", withdrawal_ref: "W1", fee_cents: 100 });
    expect((await getSupplierPayment(env.DB, a.id))?.status).toBe("ready");
    expect(await recordCashoutWithdrawn(env.DB, c.id, { withdrawalRef: "W2", feeCents: 100 })).toBeNull();
  });

  it("a failure before the sale frees the payment for a new cash-out; after the sale it never sells again", async () => {
    const a = await sp();
    const c1 = (await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 10_000 }))!;
    expect(await recordCashoutFailed(env.DB, c1.id, "USDC has not arrived at Kraken")).toMatchObject({ status: "failed", error: "USDC has not arrived at Kraken" });
    expect((await getSupplierPayment(env.DB, a.id))?.status).toBe("due");
    const c2 = (await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 10_000 }))!;
    await recordCashoutSold(env.DB, c2.id, { orderRef: "O", soldUnits: 1 });
    await recordCashoutFailed(env.DB, c2.id, "kraken down");
    // Sold: the payment stays cashing_out, so the dashboard offers Retry withdrawal, not Cash out.
    expect((await getSupplierPayment(env.DB, a.id))?.status).toBe("cashing_out");
    expect((await latestCashout(env.DB, a.id))?.id).toBe(c2.id);
    expect(await retryWithdrawal(env.DB, c1.id)).toBe(false);
    expect(await retryWithdrawal(env.DB, c2.id)).toBe(true);
    expect(await latestCashout(env.DB, a.id)).toMatchObject({ id: c2.id, status: "sold", withdraw_attempts: 0, error: null });
  });

  it("gives up on the third withdrawal error", async () => {
    const a = await sp();
    const c = (await queueCashout(env.DB, a.id, { fiat: "EUR", fiatCents: 10_000 }))!;
    await recordCashoutSold(env.DB, c.id, { orderRef: "O", soldUnits: 1 });
    expect(await recordWithdrawError(env.DB, c.id, "e1")).toMatchObject({ exhausted: false, row: { status: "sold", withdraw_attempts: 1 } });
    expect(await recordWithdrawError(env.DB, c.id, "e2")).toMatchObject({ exhausted: false, row: { withdraw_attempts: 2 } });
    expect(await recordWithdrawError(env.DB, c.id, "e3")).toMatchObject({ exhausted: true, row: { status: "failed", withdraw_attempts: 3, error: "e3" } });
    expect(await recordWithdrawError(env.DB, c.id, "e4")).toBeNull();
  });
});

describe("cash-out amounts", () => {
  const rates: Record<string, number> = { EUR: 4.3, GBP: 5, INR: 0.045, USD: 4 };
  const plnPer = (code: string) => (code === "PLN" ? 1 : rates[code] ?? null);
  const opts = { gbpEnabled: false, buffer: 0.02 };
  it("EUR is exact; GBP only when enabled; anything else is EUR at NBP plus the buffer, rounded up", () => {
    expect(cashoutAmount({ currency: "EUR", amountCents: 48_000 }, plnPer, opts)).toEqual({ fiat: "EUR", fiatCents: 48_000 });
    expect(cashoutAmount({ currency: "GBP", amountCents: 10_000 }, plnPer, { ...opts, gbpEnabled: true })).toEqual({ fiat: "GBP", fiatCents: 10_000 });
    // 100 GBP = 500 PLN = 116.279 EUR, +2% = 118.604… → 118.61
    expect(cashoutAmount({ currency: "GBP", amountCents: 10_000 }, plnPer, opts)).toEqual({ fiat: "EUR", fiatCents: 11_861 });
    // 1000 PLN / 4.3 = 232.558…, +2% = 237.209… → 237.21
    expect(cashoutAmount({ currency: "PLN", amountCents: 100_000 }, plnPer, opts)).toEqual({ fiat: "EUR", fiatCents: 23_721 });
    expect(cashoutAmount({ currency: "INR", amountCents: 1_000_000 }, (c) => (c === "INR" ? null : plnPer(c)), opts)).toBeNull();
    expect(cashoutAmount({ currency: "PLN", amountCents: 100_000 }, (c) => (c === "EUR" ? null : plnPer(c)), opts)).toBeNull();
  });
});

describe("audit and runner heartbeat", () => {
  it("logs admin actions and remembers when the runner last polled", async () => {
    await logAdminAction(env.DB, { email: "owner@example.com", action: "paid", target: "supplier_payment:1", detail: { method: "card" } });
    const row = await env.DB.prepare("SELECT * FROM admin_actions ORDER BY id DESC LIMIT 1").first<{ email: string; action: string; target: string; detail: string }>();
    expect(row).toMatchObject({ email: "owner@example.com", action: "paid", target: "supplier_payment:1", detail: '{"method":"card"}' });
    await touchRunner(env.DB, new Date("2099-10-02T10:00:00.000Z"));
    expect(await runnerLastSeen(env.DB)).toBe("2099-10-02T10:00:00.000Z");
  });
});
