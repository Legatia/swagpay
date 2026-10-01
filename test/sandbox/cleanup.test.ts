import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../../src/agent/order-agent";
import { createSupplierPayment, queueCashout } from "../../src/back-office";
import { createEscalation } from "../../src/escalations";
import { cleanupSandbox } from "../../src/sandbox/cleanup";
import { createObligation, queuePayout, recordPayoutResult } from "../../src/treasury";
import { insertQuote, intakeFor, newOrderRow } from "../fixtures";

const sandbox = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002" } as unknown as Env;
const HOUR = 3_600_000;
const NOW = new Date("2099-10-10T12:00:00Z");
const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

async function fullOrder(ageHours: number) {
  const { order } = await newOrderRow(new Date(NOW.getTime() - ageHours * HOUR));
  const quoteId = await insertQuote(env.DB, order.id);
  const now = new Date().toISOString();
  const pr = await env.DB.prepare("INSERT INTO payment_requests (order_id, quote_id, stage, token, amount_units, tag, created_at, due_by) VALUES (?, ?, 'deposit', 'USDC', 1000000, ?, ?, ?) RETURNING id").bind(order.id, quoteId, order.id, now, now).first<{ id: number }>();
  await env.DB.prepare("INSERT INTO payment_claims (tx_hash, request_id, created_at) VALUES (?, ?, ?)").bind(`0xclaim${order.id}`, pr!.id, now).run();
  await env.DB.prepare("INSERT INTO transfers (tx_hash, log_index, block_number, token, from_address, amount_units, request_id, created_at) VALUES (?, 0, 1, 'USDC', '0xabc', 1000000, ?, ?)").bind(`0xtx${order.id}`, pr!.id, now).run();
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 5_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "ARC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  const payout = (await queuePayout(env.DB, ob))!;
  await recordPayoutResult(env.DB, payout.id, { status: "sent", ref: "0xpay" });
  await env.DB.prepare("INSERT INTO sandbox_runner_sends (idempotency_key, payout_id, tx_hash, created_at) VALUES (?, ?, '0xpay', ?)").bind(payout.idempotency_key, payout.id, now).run();
  const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
  const c = (await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 20_000 }))!;
  await env.DB.prepare("INSERT INTO sandbox_bank_ledger (cashout_id, client_order_id, step, created_at) VALUES (?, ?, 'sold', ?)").bind(c.id, c.client_order_id, now).run();
  await env.DB.prepare("INSERT INTO sandbox_owner_calls (order_id, at) VALUES (?, ?)").bind(order.id, now).run();
  await createEscalation(env.DB, { orderId: order.id, kind: "system", summary: "x", payload: {} });
  // Artwork in R2, recorded in the agent.
  const key = `artwork/${order.instance}/cleanup`;
  await env.ARTWORK.put(key, "bytes");
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intakeFor());
  await runInDurableObject(stub, (inst: OrderAgent) => {
    inst.sql`INSERT INTO artwork (file_id, name, media_type, size, r2_key, at) VALUES ('f1', 'a.png', 'image/png', 5, ${key}, ${now})`;
  });
  return { order, key, payoutId: payout.id, cashoutId: c.id, spId: sp.id };
}

describe("sandbox cleanup", () => {
  it("deletes a 49-hour-old order completely and leaves a 47-hour-old one", async () => {
    const old = await fullOrder(49);
    const fresh = await fullOrder(47);
    expect(await cleanupSandbox(sandbox, NOW)).toEqual({ orders: 1 });
    const gone = async (o: typeof old) => [
      await count("SELECT COUNT(*) AS n FROM orders WHERE id = ?", o.order.id),
      await count("SELECT COUNT(*) AS n FROM quotes WHERE order_id = ?", o.order.id),
      await count("SELECT COUNT(*) AS n FROM payment_requests WHERE order_id = ?", o.order.id),
      await count("SELECT COUNT(*) AS n FROM payment_claims WHERE tx_hash = ?", `0xclaim${o.order.id}`),
      await count("SELECT COUNT(*) AS n FROM transfers WHERE tx_hash = ?", `0xtx${o.order.id}`),
      await count("SELECT COUNT(*) AS n FROM obligations WHERE order_id = ?", o.order.id),
      await count("SELECT COUNT(*) AS n FROM payouts WHERE id = ?", o.payoutId),
      await count("SELECT COUNT(*) AS n FROM sandbox_runner_sends WHERE payout_id = ?", o.payoutId),
      await count("SELECT COUNT(*) AS n FROM supplier_payments WHERE id = ?", o.spId),
      await count("SELECT COUNT(*) AS n FROM cashouts WHERE id = ?", o.cashoutId),
      await count("SELECT COUNT(*) AS n FROM sandbox_bank_ledger WHERE cashout_id = ?", o.cashoutId),
      await count("SELECT COUNT(*) AS n FROM sandbox_owner_calls WHERE order_id = ?", o.order.id),
      await count("SELECT COUNT(*) AS n FROM escalations WHERE order_id = ?", o.order.id),
    ];
    expect(await gone(old)).toEqual(new Array(13).fill(0));
    expect((await gone(fresh)).every((n) => n === 1)).toBe(true);
    expect(await env.ARTWORK.get(old.key)).toBeNull();
    expect(await env.ARTWORK.get(fresh.key)).not.toBeNull();
  });

  it("deletes artwork/ and conv/ objects of the order by prefix, and only its own", async () => {
    const old = await fullOrder(49);
    const fresh = await fullOrder(47);
    const keys = (o: typeof old) => [`artwork/${o.order.instance}/y`, `conv/${o.order.instance}/x`];
    for (const k of [...keys(old), ...keys(fresh)]) await env.ARTWORK.put(k, "b");
    // More than one page of list results.
    for (let i = 0; i < 1005; i++) await env.ARTWORK.put(`conv/${old.order.instance}/bulk-${i}`, "b");
    await cleanupSandbox(sandbox, NOW);
    expect((await env.ARTWORK.list({ prefix: `conv/${old.order.instance}/` })).objects).toHaveLength(0);
    expect((await env.ARTWORK.list({ prefix: `artwork/${old.order.instance}/` })).objects).toHaveLength(0);
    for (const k of keys(fresh)) expect(await env.ARTWORK.get(k)).not.toBeNull();
  });

  it("does nothing outside the sandbox", async () => {
    const old = await fullOrder(60);
    expect(await cleanupSandbox(env, NOW)).toEqual({ orders: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE id = ?", old.order.id)).toBe(1);
  });

  it("deletes an order whose agent was never initialised", async () => {
    const { order } = await newOrderRow(new Date(NOW.getTime() - 49 * HOUR));
    await env.DB.prepare("INSERT INTO sandbox_owner_calls (order_id, at) VALUES (?, ?)").bind(order.id, NOW.toISOString()).run();
    expect((await cleanupSandbox(sandbox, NOW)).orders).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE id = ?", order.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sandbox_owner_calls WHERE order_id = ?", order.id)).toBe(0);
  });

  it("skips an order whose agent is mid-turn", async () => {
    const busy = await fullOrder(49);
    const stub = await getAgentByName(env.OrderAgent, busy.order.instance);
    await runInDurableObject(stub, (inst: OrderAgent) => { (inst as unknown as { turnRunning: boolean }).turnRunning = true; });
    await cleanupSandbox(sandbox, NOW);
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE id = ?", busy.order.id)).toBe(1);
    expect(await env.ARTWORK.get(busy.key)).not.toBeNull();
    await runInDurableObject(stub, (inst: OrderAgent) => { (inst as unknown as { turnRunning: boolean }).turnRunning = false; });
    await cleanupSandbox(sandbox, NOW);
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE id = ?", busy.order.id)).toBe(0);
  });
});
