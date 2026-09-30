import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { createSupplierPayment, getSupplierPayment, latestCashout, queueCashout, recordCashoutFailed, recordCashoutSold } from "../src/back-office";
import { createEscalation, getEscalation, listEscalations } from "../src/escalations";
import { createObligation, queuePayout, recordPayoutResult } from "../src/treasury";
import { getVendor } from "../src/vendors";
import { TEAM, makeSigner } from "./access-signer";
import { insertQuote, newOrderRow } from "./fixtures";

async function post(path: string, fields: Record<string, string>, opts: { origin?: string | null; token?: string | null } = {}) {
  const { sign, fetchImpl } = await makeSigner();
  const token = opts.token === undefined ? await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" }) : opts.token;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (token) headers["cf-access-jwt-assertion"] = token;
  const origin = opts.origin === undefined ? "https://swagpay.test" : opts.origin;
  if (origin) headers.origin = origin;
  return handleAdmin(new Request(`https://swagpay.test${path}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() }), env, { fetch: fetchImpl });
}
const msgOf = (res: Response) => new URL(res.headers.get("location")!, "https://swagpay.test").searchParams.get("msg");
const audit = async () => env.DB.prepare("SELECT action, target, email FROM admin_actions ORDER BY id DESC LIMIT 1").first<{ action: string; target: string; email: string }>();

async function readyToCashOut(currency = "PLN", amountCents = 100_000) {
  const { order } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id);
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  await recordPayoutResult(env.DB, (await queuePayout(env.DB, ob))!.id, { status: "sent", ref: "c" });
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('EUR', 4.3, '2099-09-30', ?), ('USD', 4, '2099-09-30', ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
  return { order, sp: await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency, amountCents }) };
}

describe("admin actions", () => {
  it("refuse without Access or from another origin, and change nothing", async () => {
    const { sp } = await readyToCashOut();
    expect((await post(`/admin/payments/${sp.id}/cashout`, { back: "/admin" }, { token: null })).status).toBe(403);
    expect((await post(`/admin/payments/${sp.id}/cashout`, { back: "/admin" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`/admin/payments/${sp.id}/cashout`, { back: "/admin" }, { origin: null })).status).toBe(403);
    expect((await getSupplierPayment(env.DB, sp.id))?.status).toBe("due");
  });

  it("Cash out queues EUR at NBP plus 2% for a PLN printer, once, and redirects back with a message", async () => {
    const { sp } = await readyToCashOut();
    const res = await post(`/admin/payments/${sp.id}/cashout`, { back: `/admin/orders/${sp.order_id}` });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(new RegExp(`^/admin/orders/${sp.order_id}\\?msg=`));
    expect(msgOf(res)).toBe("Cash-out queued: 237.21 EUR to your EUR account. The wallet runner sells and withdraws it.");
    expect(await latestCashout(env.DB, sp.id)).toMatchObject({ fiat: "EUR", fiat_cents: 23_721, status: "queued" });
    expect(await audit()).toEqual({ action: "cashout", target: `supplier_payment:${sp.id}`, email: "owner@example.com" });
    expect(msgOf(await post(`/admin/payments/${sp.id}/cashout`, { back: "/admin" }))).toBe("This payment is already cashing out.");
  });

  it("Cash out is refused before the treasury's payout reached Kraken, or without a fresh rate", async () => {
    const { order } = await newOrderRow();
    const early = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "EUR", amountCents: 10_000 });
    expect(msgOf(await post(`/admin/payments/${early.id}/cashout`, { back: "/admin" }))).toBe("The treasury hasn't sent this printer cost to Kraken yet.");
    const { sp } = await readyToCashOut("INR", 1_000_000);
    await env.DB.prepare("DELETE FROM fx_rates WHERE code = 'INR'").run();
    expect(msgOf(await post(`/admin/payments/${sp.id}/cashout`, { back: "/admin" }))).toBe("No fresh NBP rate for INR: try again after the next hourly refresh.");
    expect((await getSupplierPayment(env.DB, sp.id))?.status).toBe("due");
  });

  it("Paid records the method; while cashing out it needs confirmation", async () => {
    const { sp } = await readyToCashOut();
    await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 1 });
    expect(msgOf(await post(`/admin/payments/${sp.id}/paid`, { back: "/admin", method: "blik", reference: "", date: "2099-10-02" }))).toBe("A cash-out is still in progress: tick 'money has arrived' to mark it paid anyway.");
    expect((await getSupplierPayment(env.DB, sp.id))?.status).toBe("cashing_out");
    const res = await post(`/admin/payments/${sp.id}/paid`, { back: "/admin", method: "blik", reference: "BLIK 12", date: "2099-10-02", confirm: "1" });
    expect(msgOf(res)).toBe(`Printer payment for order ${sp.order_id} marked paid (blik).`);
    expect(await getSupplierPayment(env.DB, sp.id)).toMatchObject({ status: "paid", method: "blik", reference: "BLIK 12", paid_at: "2099-10-02T12:00:00.000Z" });
    expect(msgOf(await post(`/admin/payments/${sp.id}/paid`, { back: "/admin", method: "qr", date: "2099-10-02" }))).toBe("Choose card, blik or transfer.");
  });

  it("Cancel and Retry withdrawal", async () => {
    const { sp } = await readyToCashOut();
    const c = (await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 1 }))!;
    await recordCashoutSold(env.DB, c.id, { orderRef: "O", soldUnits: 1 });
    await recordCashoutFailed(env.DB, c.id, "kraken down");
    expect(msgOf(await post(`/admin/cashouts/${c.id}/retry`, { back: "/admin" }))).toBe(`Cash-out #${c.id} will retry the withdrawal on the runner's next poll.`);
    expect((await latestCashout(env.DB, sp.id))?.status).toBe("sold");
    const other = await readyToCashOut();
    expect(msgOf(await post(`/admin/payments/${other.sp.id}/cancel`, { back: "/admin", note: "printer did it for free" }))).toBe(`Printer payment for order ${other.sp.order_id} cancelled.`);
    expect(await getSupplierPayment(env.DB, other.sp.id)).toMatchObject({ status: "cancelled", note: "printer did it for free" });
  });

  it("Approve and Reject go through decide(), like Telegram", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "system", summary: "Model failed", payload: {} });
    expect(msgOf(await post(`/admin/escalations/${e.id}/decide`, { back: "/admin", decision: "approve", note: "" }))).toBe(`#${e.id} acknowledged.`);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("approved");
    expect(msgOf(await post(`/admin/escalations/${e.id}/decide`, { back: "/admin", decision: "reject" }))).toMatch(new RegExp(`^#${e.id} is already`));
  });

  it("editing a printer's payment details is logged and sent to the owner in Telegram", async () => {
    const v = (await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES ('Druk', 'Warsaw', 'PL', '[]', 'partner', 'w:act', 'x', 'x') RETURNING id").first<{ id: number }>())!.id;
    const res = await post(`/admin/suppliers/${v}`, { back: "/admin/suppliers", pay_currency: "PLN", how_to_pay: "BLIK to 600 000 000" });
    expect(msgOf(res)).toBe(`Printer #${v} updated.`);
    expect(await getVendor(env.DB, v)).toMatchObject({ pay_currency: "PLN", how_to_pay: "BLIK to 600 000 000" });
    const notice = (await listEscalations(env.DB)).find((x) => x.summary.startsWith(`Printer #${v} payment details changed`))!;
    expect(notice).toMatchObject({ kind: "system", order_id: null });
    expect(msgOf(await post(`/admin/suppliers/${v}`, { back: "/admin/suppliers", pay_currency: "BTC", how_to_pay: "" }))).toBe("Currency must be one of PLN, EUR, GBP, USD, INR.");
  });

  it("redirects only within /admin", async () => {
    const { sp } = await readyToCashOut();
    const res = await post(`/admin/payments/${sp.id}/cancel`, { back: "https://evil.example/x", note: "" });
    expect(res.headers.get("location")).toMatch(/^\/admin\?msg=/);
  });
});
