import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertDecision } from "../src/db";
import { insertTreasuryDecision } from "../src/treasury";
import { newOrderRow } from "./fixtures";

describe("public log and metrics", () => {
  it("lists both agents' decisions newest first without inputs, escaped", async () => {
    const { order } = await newOrderRow();
    await insertDecision(env.DB, { orderId: order.id, tool: "send_quote", reason: "cost arrived <b>inside</b> the band", input: { contactEmail: "ana@example.com" }, verdict: "allow", outcome: "done" }, new Date("2099-01-01T10:00:00Z"));
    await insertTreasuryDecision(env.DB, { orderId: order.id, tool: "pay_obligation", reason: "deposit covers the printer cost", input: { secret: "x" }, verdict: "allow", outcome: "done" }, new Date("2099-01-01T11:00:00Z"));
    const api = await (await SELF.fetch("https://swagpay.test/api/log")).json<{ decisions: Array<{ agent: string; tool: string; order: number | null }> }>();
    expect(api.decisions[0]).toMatchObject({ agent: "treasury", tool: "pay_obligation", order: order.id });
    expect(api.decisions[1]).toMatchObject({ agent: "order", tool: "send_quote" });
    expect(JSON.stringify(api)).not.toContain("ana@example.com");
    const page = await SELF.fetch("https://swagpay.test/log");
    expect(page.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await page.text();
    expect(html).toContain("cost arrived &lt;b&gt;inside&lt;/b&gt; the band");
    expect(html).not.toContain("ana@example.com");
    expect(html).not.toContain('"secret"');
  });

  it("counts money in and out and decisions made against escalated", async () => {
    const { order } = await newOrderRow();
    await env.DB.prepare("INSERT INTO transfers (tx_hash, log_index, block_number, token, from_address, amount_units, request_id, created_at) VALUES (?, 0, 1, 'USDC', '0x2', 5000000, NULL, ?)")
      .bind(`0x${"e".repeat(64)}`, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO obligations (order_id, kind, token, amount_units, destination, chain, due_at, status, source_ref, created_at) VALUES (?, 'printer_cost', 'USDC', 2000000, '0x3', 'ARC', ?, 'paid', ?, ?)")
      .bind(order.id, new Date().toISOString(), `metrics:${crypto.randomUUID()}`, new Date().toISOString()).run();
    const ob = await env.DB.prepare("SELECT id FROM obligations ORDER BY id DESC LIMIT 1").first<{ id: number }>();
    await env.DB.prepare("INSERT INTO payouts (obligation_id, method, chain, token, amount_units, destination, idempotency_key, status, created_at, updated_at) VALUES (?, 'transfer', 'ARC', 'USDC', 2000000, '0x3', ?, 'sent', ?, ?)")
      .bind(ob!.id, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()).run();
    await insertDecision(env.DB, { orderId: order.id, tool: "escalate", reason: "discount asked", input: {}, verdict: "escalate", outcome: "escalated" });
    const m = await (await SELF.fetch("https://swagpay.test/api/metrics")).json<{
      orders: Record<string, number>; paidOut: { USDC: string }; obligations: { settledByAgent: number }; decisions: { total: number; escalated: number };
    }>();
    expect(m.orders.draft).toBeGreaterThanOrEqual(1);
    expect(Number(m.paidOut.USDC)).toBeGreaterThanOrEqual(2);
    expect(m.obligations.settledByAgent).toBeGreaterThanOrEqual(1);
    expect(m.decisions.escalated).toBeGreaterThanOrEqual(1);
    expect(m.decisions.total).toBeGreaterThanOrEqual(m.decisions.escalated);
  });
});
