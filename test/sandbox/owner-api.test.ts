import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../../src/agent/order-agent";
import { handleApi } from "../../src/api";
import { createSupplierPayment, latestCashout, queueCashout, recordCashoutFailed, recordCashoutSold } from "../../src/back-office";
import { createEscalation, getEscalation } from "../../src/escalations";
import type { SandboxOwnerState } from "../../src/sandbox/owner-api";
import { saveOrderSpec } from "../../src/db";
import { createObligation, queuePayout, recordPayoutResult } from "../../src/treasury";
import { completeSpec, insertQuote, intakeFor, newOrderRow } from "../fixtures";

const sandbox = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002" } as unknown as Env;
const base = "https://sandbox.test";

const get = (token: string, e: Env = sandbox) => handleApi(new Request(`${base}/api/o/${token}/sandbox/owner`), e);
const post = (token: string, action: string, body: unknown = {}, e: Env = sandbox) =>
  handleApi(new Request(`${base}/api/o/${token}/sandbox/owner/${action}`, { method: "POST", body: JSON.stringify(body) }), e);
const state = async (token: string) => (await get(token)).json<SandboxOwnerState>();

async function readyToCashOut() {
  const { order, token } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id);
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  await recordPayoutResult(env.DB, (await queuePayout(env.DB, ob))!.id, { status: "sent", ref: "c" });
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('EUR', 4.3, '2099-09-30', ?), ('USD', 4, '2099-09-30', ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
  const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
  return { order, token, sp, ob };
}

describe("sandbox owner panel API", () => {
  it("answers 404 in production and for an unknown token", async () => {
    const { token } = await newOrderRow();
    expect((await get(token, env)).status).toBe(404);
    expect((await post(token, "skip", {}, env)).status).toBe(404);
    expect((await get("x".repeat(43))).status).toBe(404);
    expect((await post("x".repeat(43), "skip")).status).toBe(404);
  });

  it("lists the order and, for a ready payment, the cashout action", async () => {
    const { order, token, sp } = await readyToCashOut();
    const s = await state(token);
    expect(s.order).toEqual({ id: order.id, status: order.status });
    expect(s.payment).toMatchObject({ id: sp.id, currency: "PLN", amountCents: 100_000, label: "ready to cash out" });
    expect(s.payment!.actions).toContain("cashout");
    expect(s).toMatchObject({ pending: [], cost: null, cashout: null, printer: { lastStep: null, nextStep: null, nextAt: null } });
  });

  it("cashout queues a cash-out and the state shows it", async () => {
    const { token, sp } = await readyToCashOut();
    const res = await post(token, "cashout");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await latestCashout(env.DB, sp.id)).toMatchObject({ status: "queued" });
    expect((await state(token)).cashout).toMatchObject({ status: "queued", fiat: "EUR", withdrawalRef: null });
    expect((await env.DB.prepare("SELECT email FROM admin_actions ORDER BY id DESC LIMIT 1").first<{ email: string }>())?.email).toBe("sandbox");
  });

  it("paid defaults the date to today in Warsaw, cancel and retry act on this order's payment", async () => {
    const a = await readyToCashOut();
    expect(await (await post(a.token, "paid", { method: "qr" })).json()).toMatchObject({ ok: false, message: "Choose card, blik or transfer." });
    const res = await post(a.token, "paid", { method: "blik", reference: "BLIK 1" });
    expect(await res.json()).toMatchObject({ ok: true });
    const row = await env.DB.prepare("SELECT status, paid_at FROM supplier_payments WHERE id = ?").bind(a.sp.id).first<{ status: string; paid_at: string }>();
    expect(row?.status).toBe("paid");
    expect(row?.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00\.000Z$/);

    const b = await readyToCashOut();
    expect(await (await post(b.token, "cancel", { note: "no" })).json()).toMatchObject({ ok: true });

    const c = await readyToCashOut();
    const co = (await queueCashout(env.DB, c.sp.id, { fiat: "EUR", fiatCents: 1 }))!;
    await recordCashoutSold(env.DB, co.id, { orderRef: "O", soldUnits: 1 });
    await recordCashoutFailed(env.DB, co.id, "kraken down");
    expect((await state(c.token)).payment!.actions).toContain("retry");
    expect(await (await post(c.token, "retry")).json()).toMatchObject({ ok: true });
    expect(await (await post(c.token, "retry")).json()).toMatchObject({ ok: false });
  });

  it("bad input is 400", async () => {
    const { token } = await readyToCashOut();
    expect((await post(token, "nope")).status).toBe(400);
    expect((await post(token, "decide", { escalationId: "x", decision: "approve" })).status).toBe(400);
    expect((await post(token, "decide", { escalationId: 1, decision: "maybe" })).status).toBe(400);
    expect((await post(token, "cost", { amount: -1, currency: "PLN" })).status).toBe(400);
    expect((await post(token, "cost", { amount: 10, currency: "CHF" })).status).toBe(400);
    expect((await post(token, "paid", {})).status).toBe(400);
  });

  it("skip says there is nothing to skip until the printer is wired in", async () => {
    const { token } = await newOrderRow();
    const res = await post(token, "skip");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, message: "Nothing to skip." });
  });

  it("decide works for this order's escalation, and another order's token gets 404", async () => {
    const a = await newOrderRow();
    const b = await newOrderRow();
    // Deciding tells the order's agent, which must exist.
    await (await getAgentByName(env.OrderAgent, a.order.instance)).init(a.order.id, intakeFor());
    const esc = await createEscalation(env.DB, { orderId: a.order.id, kind: "approval", summary: "Discount above the limit", payload: {} });
    expect((await state(a.token)).pending).toEqual([{ id: esc.id, kind: "approval", why: "Discount above the limit", actions: ["approve", "reject"] }]);
    expect((await state(b.token)).pending).toEqual([]);
    expect((await post(b.token, "decide", { escalationId: esc.id, decision: "approve" })).status).toBe(404);
    expect((await post(b.token, "decide", { escalationId: 999_999, decision: "approve" })).status).toBe(404);
    expect((await getEscalation(env.DB, esc.id))?.status).toBe("open");
    const res = await post(a.token, "decide", { escalationId: esc.id, decision: "reject", note: "too much" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect((await getEscalation(env.DB, esc.id))?.status).toBe("rejected");
    expect((await state(a.token)).pending).toEqual([]);
  });

  it("a payment notice offers only approve, and rejecting it is refused", async () => {
    const a = await newOrderRow();
    await (await getAgentByName(env.OrderAgent, a.order.instance)).init(a.order.id, intakeFor());
    const n = await createEscalation(env.DB, { orderId: a.order.id, kind: "payment", summary: "Paid", payload: {} });
    expect((await state(a.token)).pending).toEqual([{ id: n.id, kind: "payment", why: "Paid", actions: ["approve"] }]);
    const res = await post(a.token, "decide", { escalationId: n.id, decision: "reject" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, message: "This is a notice: acknowledge it." });
    expect((await getEscalation(env.DB, n.id))?.status).toBe("open");
  });

  it("pending includes orderless treasury escalations pointing at this order's obligation or cash-out, only while open", async () => {
    const a = await readyToCashOut();
    const b = await readyToCashOut();
    const co = (await queueCashout(env.DB, a.sp.id, { fiat: "EUR", fiatCents: 1 }))!;
    const viaObligation = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Payout above the limit", payload: { obligationId: a.ob.id } });
    const viaCashout = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Cash-out above the limit", payload: { cashoutId: co.id } });
    const other = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Other order's payout", payload: { obligationId: b.ob.id } });
    const unrelated = await createEscalation(env.DB, { orderId: null, kind: "system", summary: "Budget spent", payload: {} });
    const ids = (await state(a.token)).pending.map((p) => p.id);
    expect(ids).toEqual([viaObligation.id, viaCashout.id]);
    expect((await state(b.token)).pending.map((p) => p.id)).toEqual([other.id]);
    expect(ids).not.toContain(unrelated.id);
    // The panel may decide it; the other order may not.
    expect((await post(b.token, "decide", { escalationId: viaObligation.id, decision: "approve" })).status).toBe(404);
    expect((await post(a.token, "decide", { escalationId: unrelated.id, decision: "approve" })).status).toBe(404);
    expect((await post(a.token, "decide", { escalationId: viaObligation.id, decision: "reject" })).status).toBe(200);
    expect((await state(a.token)).pending.map((p) => p.id)).toEqual([viaCashout.id]);
  });

  it("cost with no open cost request is 400", async () => {
    const { token } = await newOrderRow();
    const res = await post(token, "cost", { amount: 100, currency: "PLN" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, message: "No open cost request." });
  });

  it("cost with an open request suggests printers with simulated quotes, then calls giveCost", async () => {
    const { order, token } = await newOrderRow();
    await saveOrderSpec(env.DB, order.id, completeSpec);
    const agent = await getAgentByName(env.OrderAgent, order.instance);
    await agent.init(order.id, intakeFor());
    await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, email, status, source_ref, created_at, updated_at) VALUES ('Warsaw Print', 'Warsaw', 'PL', '[\"screen\",\"diecut\"]', 'secret@printer.example', 'screened', 'sbx-1', 'x', 'x')").run();
    await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES ('Candidate Print', 'Warsaw', 'PL', '[]', 'candidate', 'sbx-2', 'x', 'x')").run();
    const cost = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    await runInDurableObject(agent, async (a: OrderAgent) => { a.sql`INSERT INTO escalated (key, escalation_id) VALUES (${`cost:k-${cost.id}`}, ${cost.id})`; });

    const s = await state(token);
    expect(s.pending).toEqual([]);
    expect(s.cost?.escalationId).toBe(cost.id);
    expect(s.cost!.suggestions).toHaveLength(1);
    expect(s.cost!.suggestions[0]).toMatchObject({ name: "Warsaw Print", city: "Warsaw", quote: { currency: "PLN", amount: 14_000 } });
    expect(s.cost!.suggestions[0].quote!.label).toMatch(/simulated/);
    expect(JSON.stringify(s)).not.toContain("secret@printer.example");

    const vendorId = s.cost!.suggestions[0].vendorId;
    const res = await post(token, "cost", { amount: 1000, currency: "PLN", vendorId, note: "ok" });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; message: string }>();
    expect(body.message).toMatch(new RegExp(`^#${cost.id}: 1000\\.00 PLN recorded for order ${order.id}`));
    expect((await getEscalation(env.DB, cost.id))?.status).toBe("approved");
    expect((await state(token)).cost).toBeNull();
  });

  it("allows 30 POSTs per order per hour, then 429; another order is unaffected", async () => {
    const a = await newOrderRow();
    const b = await newOrderRow();
    for (let i = 0; i < 30; i++) expect((await post(a.token, "skip")).status).toBe(200);
    const limited = await post(a.token, "skip");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await get(a.token)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await post(a.token, "skip")).status).toBe(429);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sandbox_owner_calls WHERE order_id = ?").bind(a.order.id).first<{ n: number }>())!.n).toBe(30);
    expect((await post(b.token, "skip")).status).toBe(200);
    // An hour later the counter has emptied.
    await env.DB.prepare("UPDATE sandbox_owner_calls SET at = ? WHERE order_id = ?").bind(new Date(Date.now() - 3_700_000).toISOString(), a.order.id).run();
    expect((await post(a.token, "skip")).status).toBe(200);
  });
});
