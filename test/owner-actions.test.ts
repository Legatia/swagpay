import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSupplierPayment, latestCashout, queueCashout } from "../src/back-office";
import { cancelSupplierPayment, cashOut, decideAsOwner, markSupplierPaid, retryCashoutWithdrawal } from "../src/owner-actions";
import { createEscalation, getEscalation } from "../src/escalations";
import { createObligation, queuePayout, recordPayoutResult } from "../src/treasury";
import { insertQuote, newOrderRow } from "./fixtures";

const lastAudit = () => env.DB.prepare("SELECT action, target, email FROM admin_actions ORDER BY id DESC LIMIT 1").first<{ action: string; target: string; email: string }>();
const auditCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first<{ n: number }>())!.n;

async function readyToCashOut() {
  const { order } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id);
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  await recordPayoutResult(env.DB, (await queuePayout(env.DB, ob))!.id, { status: "sent", ref: "c" });
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('EUR', 4.3, '2099-09-30', ?)").bind(new Date().toISOString()).run();
  return createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
}

describe("owner actions", () => {
  it("cashOut queues the cash-out and audits it as the given actor", async () => {
    const sp = await readyToCashOut();
    const r = await cashOut(env, sp.id, "sandbox");
    expect(r).toEqual({ ok: true, message: "Cash-out queued: 237.21 EUR to your EUR account. The wallet runner sells and withdraws it." });
    expect(await latestCashout(env.DB, sp.id)).toMatchObject({ fiat: "EUR", status: "queued" });
    expect(await lastAudit()).toEqual({ action: "cashout", target: `supplier_payment:${sp.id}`, email: "sandbox" });
    expect(await cashOut(env, 999_999, "sandbox")).toEqual({ ok: false, message: "Not found." });
  });

  it("markSupplierPaid needs confirmation while a cash-out is in progress", async () => {
    const sp = await readyToCashOut();
    await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 1 });
    const p = { method: "blik", reference: null, date: "2099-10-02", confirm: false };
    expect(await markSupplierPaid(env, sp.id, p, "sandbox")).toEqual({ ok: false, message: "A cash-out is still in progress: tick 'money has arrived' to mark it paid anyway." });
    const r = await markSupplierPaid(env, sp.id, { ...p, confirm: true }, "sandbox");
    expect(r).toEqual({ ok: true, message: `Printer payment for order ${sp.order_id} marked paid (blik).` });
    expect(await lastAudit()).toEqual({ action: "paid", target: `supplier_payment:${sp.id}`, email: "sandbox" });
  });

  it("cancelSupplierPayment cancels a due payment", async () => {
    const sp = await readyToCashOut();
    expect(await cancelSupplierPayment(env, sp.id, "free", "sandbox")).toEqual({ ok: true, message: `Printer payment for order ${sp.order_id} cancelled.` });
    expect(await lastAudit()).toEqual({ action: "cancel", target: `supplier_payment:${sp.id}`, email: "sandbox" });
    expect((await cancelSupplierPayment(env, sp.id, null, "sandbox")).ok).toBe(false);
  });

  it("retryCashoutWithdrawal answers Not found for an unknown id", async () => {
    expect(await retryCashoutWithdrawal(env, 999_999, "sandbox")).toEqual({ ok: false, message: "Not found." });
  });

  it("decideAsOwner decides once; a decided escalation writes no audit row", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "system", summary: "Model failed", payload: {} });
    const r = await decideAsOwner(env, e.id, "approve", null, "sandbox");
    expect(r).toEqual({ ok: true, message: `#${e.id} acknowledged.` });
    expect((await getEscalation(env.DB, e.id))?.status).toBe("approved");
    expect(await lastAudit()).toEqual({ action: "approve", target: `escalation:${e.id}`, email: "sandbox" });
    const n = await auditCount();
    expect((await decideAsOwner(env, e.id, "reject", null, "sandbox")).ok).toBe(false);
    expect(await auditCount()).toBe(n);
  });
});
