import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createObligation, getObligation, insertTreasuryDecision, listQueuedPayouts, loadTreasuryPolicy, orderMargin, payoutsLast24h,
  printerCostUnits, queuePayout, queuedUnits, recordPayoutResult, setObligationStatus,
} from "../src/treasury";
import { newOrderRow } from "./fixtures";

const PAYOUT = "0x3333333333333333333333333333333333333333";
let ref = 0;
const obligation = async (o: Partial<{ amountUnits: number; orderId: number | null; kind: "printer_cost" | "refund" | "reserve" }> = {}) =>
  createObligation(env.DB, {
    orderId: o.orderId ?? null, kind: o.kind ?? "printer_cost", token: "USDC", amountUnits: o.amountUnits ?? 100_000_000,
    destination: PAYOUT, chain: "MATIC", dueAt: new Date(), sourceRef: `test:${++ref}:${crypto.randomUUID()}`,
  });

describe("treasury policy", () => {
  it("reads limits in USDC units and addresses, with defaults", () => {
    const p = loadTreasuryPolicy({ PAYOUT_ADDRESS: PAYOUT, PAYOUT_CHAIN: "MATIC" });
    expect(p).toMatchObject({ perTxUnits: 500_000_000, dailyUnits: 1_500_000_000, reserveMinBps: 1000, reserveMaxBps: 3000, payoutChain: "MATIC", payoutAddress: PAYOUT, reserveAddress: null });
    expect(loadTreasuryPolicy({ TREASURY_PER_TX_USDC: "20.5" }).perTxUnits).toBe(20_500_000);
    expect(() => loadTreasuryPolicy({ TREASURY_DAILY_USDC: "-1" })).toThrow();
    expect(() => loadTreasuryPolicy({ TREASURY_RESERVE_MIN_BPS: "4000", TREASURY_RESERVE_MAX_BPS: "3000" })).toThrow();
    expect(loadTreasuryPolicy({ PAYOUT_ADDRESS: "not-an-address" }).payoutAddress).toBeNull();
  });

  it("converts the printer's PLN cost at the quote's rate plus the FX buffer, rounded up", () => {
    expect(printerCostUnits({ cost_pln_grosze: 100_000, pln_per_unit: 4 }, 0.03)).toBe(257_500_000);
    expect(printerCostUnits({ cost_pln_grosze: 1, pln_per_unit: 3 }, 0)).toBe(3334);
  });
});

describe("obligations and payouts", () => {
  it("dedupes obligations by source ref", async () => {
    const a = await createObligation(env.DB, { orderId: null, kind: "refund", token: "USDC", amountUnits: 5, destination: PAYOUT, chain: "ARC", dueAt: new Date(), sourceRef: "refund:dup" });
    const b = await createObligation(env.DB, { orderId: null, kind: "refund", token: "USDC", amountUnits: 9, destination: PAYOUT, chain: "ARC", dueAt: new Date(), sourceRef: "refund:dup" });
    expect(b.id).toBe(a.id);
    expect(b.amount_units).toBe(5);
  });

  it("queues one payout per obligation, even when asked twice at once", async () => {
    const ob = await obligation();
    const [x, y] = await Promise.all([queuePayout(env.DB, ob), queuePayout(env.DB, ob)]);
    expect([x, y].filter((p) => p !== null)).toHaveLength(1);
    const p = (x ?? y)!;
    expect(p).toMatchObject({ obligation_id: ob.id, method: "bridge", chain: "MATIC", token: "USDC", amount_units: 100_000_000, status: "queued" });
    expect((await getObligation(env.DB, ob.id))?.status).toBe("queued");
    expect((await listQueuedPayouts(env.DB)).map((q) => q.id)).toContain(p.id);
    expect(await queuePayout(env.DB, (await getObligation(env.DB, ob.id))!)).toBeNull();
  });

  it("records results: sent pays the obligation, denied escalates it, failed allows a retry", async () => {
    const sent = await obligation();
    const ps = (await queuePayout(env.DB, sent))!;
    expect((await recordPayoutResult(env.DB, ps.id, { status: "sent", ref: "circle-tx-1" }))?.obligation.status).toBe("paid");
    expect(await recordPayoutResult(env.DB, ps.id, { status: "failed", error: "late duplicate" })).toBeNull();
    expect((await getObligation(env.DB, sent.id))?.status).toBe("paid");

    const denied = await obligation();
    const pd = (await queuePayout(env.DB, denied))!;
    expect((await recordPayoutResult(env.DB, pd.id, { status: "denied", error: "daily limit" }))?.obligation.status).toBe("escalated");

    const failed = await obligation();
    const pf = (await queuePayout(env.DB, failed))!;
    await recordPayoutResult(env.DB, pf.id, { status: "failed", error: "rpc down" });
    const retry = await queuePayout(env.DB, (await getObligation(env.DB, failed.id))!);
    expect(retry).not.toBeNull();
    // A late result for the first payout must not touch the obligation, which now has a new live payout.
    expect(await recordPayoutResult(env.DB, pf.id, { status: "sent" })).toBeNull();
    expect((await getObligation(env.DB, failed.id))?.status).toBe("queued");
  });

  it("sums the last 24 hours and what is queued", async () => {
    const before = await payoutsLast24h(env.DB);
    const queuedBefore = await queuedUnits(env.DB);
    const ob = await obligation({ amountUnits: 7_000_000 });
    await queuePayout(env.DB, ob);
    expect(await payoutsLast24h(env.DB)).toBe(before + 7_000_000);
    expect(await queuedUnits(env.DB)).toBe(queuedBefore + 7_000_000);
    expect(await payoutsLast24h(env.DB, new Date(Date.now() + 25 * 3_600_000))).toBe(0);
  });

  it("moves status only from allowed states", async () => {
    const ob = await obligation();
    expect(await setObligationStatus(env.DB, ob.id, ["escalated"], "approved", { approvedBy: "owner" })).toBe(false);
    expect(await setObligationStatus(env.DB, ob.id, ["open"], "approved", { approvedBy: "owner" })).toBe(true);
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "approved", approved_by: "owner" });
  });

  it("computes an order's margin and logs treasury decisions with or without an order", async () => {
    const { order } = await newOrderRow();
    await env.DB.prepare("INSERT INTO quotes (order_id, currency, price_cents, deposit_cents, cost_pln_grosze, pln_per_unit, usd_per_unit, markup, items_key, status, issued_at, valid_until) VALUES (?, 'USD', 38000, 25750, 100000, 4, 1, 0.45, 'k', 'accepted', ?, ?)")
      .bind(order.id, new Date().toISOString(), new Date().toISOString()).run();
    const q = await env.DB.prepare("SELECT id FROM quotes WHERE order_id = ?").bind(order.id).first<{ id: number }>();
    await env.DB.prepare("INSERT INTO payment_requests (order_id, quote_id, stage, token, amount_units, tag, paid_units, status, created_at, due_by) VALUES (?, ?, 'deposit', 'USDC', 257500001, 1, 300000000, 'paid', ?, ?)")
      .bind(order.id, q!.id, new Date().toISOString(), new Date().toISOString()).run();
    await obligation({ orderId: order.id, amountUnits: 257_500_000 });
    expect(await orderMargin(env.DB, order.id)).toEqual({ status: "draft", token: "USDC", receivedUnits: 257_500_001, printerCostUnits: 257_500_000 });
    await insertTreasuryDecision(env.DB, { orderId: order.id, tool: "pay_obligation", reason: "deposit paid", input: {}, verdict: "allow", outcome: "done" });
    await insertTreasuryDecision(env.DB, { orderId: 999_999, tool: "escalate", reason: "odd", input: {}, verdict: "escalate", outcome: "escalated" });
    const rows = (await env.DB.prepare("SELECT order_id FROM treasury_decisions ORDER BY id DESC LIMIT 2").all<{ order_id: number | null }>()).results;
    expect(rows.map((r) => r.order_id)).toEqual([null, order.id]);
  });
});
