import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertDecision } from "../src/db";
import { redactReason, renderLog } from "../src/public-log";
import { insertTreasuryDecision } from "../src/treasury";
import { newOrderRow } from "./fixtures";

describe("public log and metrics", () => {
  it("lists both agents' decisions newest first without inputs, escaped", async () => {
    const { order } = await newOrderRow();
    await insertDecision(env.DB, { orderId: order.id, tool: "send_quote", reason: "cost arrived <b>inside</b> the band, mail ana@example.com", input: { contactEmail: "ana@example.com" }, verdict: "allow", outcome: "done" }, new Date("2099-01-01T10:00:00Z"));
    await insertTreasuryDecision(env.DB, { orderId: order.id, tool: "pay_obligation", reason: "deposit covers the printer cost, paid to 0x1234567890123456789012345678901234567890", input: { secret: "x" }, verdict: "allow", outcome: "done" }, new Date("2099-01-01T11:00:00Z"));
    const api = await (await SELF.fetch("https://swagpay.test/api/log")).json<{ decisions: Array<{ agent: string; tool: string; order: number | null }> }>();
    expect(api.decisions[0]).toMatchObject({ agent: "treasury", tool: "pay_obligation", order: order.id });
    expect(api.decisions[1]).toMatchObject({ agent: "order", tool: "send_quote" });
    expect(JSON.stringify(api)).not.toContain("ana@example.com");
    const page = await SELF.fetch("https://swagpay.test/log");
    expect(page.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await page.text();
    expect(html).toContain("cost arrived &lt;b&gt;inside&lt;/b&gt; the band, mail [email]");
    expect(html).toContain("deposit covers the printer cost, paid to [address]");
    expect(html).not.toContain("0x1234567890123456789012345678901234567890");
    expect(JSON.stringify(api)).not.toContain("example.com");
    expect(html).not.toContain("ana@example.com");
    expect(html).not.toContain('"secret"');
  });

  it("redacts emails, phones, amounts and wallet addresses but keeps tx hashes, dates and order numbers", () => {
    expect(redactReason("write to ana@example.com")).toBe("write to [email]");
    expect(redactReason("call +48 600 123 456 now")).toBe("call [phone] now");
    expect(redactReason("call 600-123-456 now")).toBe("call [phone] now");
    const a = "0x1234567890123456789012345678901234567890";
    expect(redactReason(`sent to ${a}`)).toBe("sent to [address]");
    expect(redactReason(`to 0x${"aB".repeat(20)}.`)).toBe("to [address].");
    const tx = `0x${"ab".repeat(32)}`;
    expect(redactReason(`tx ${tx} confirmed`)).toBe(`tx ${tx} confirmed`);
    expect(redactReason("pay the 257.50 USDC printer cost")).toBe("pay the [amount] printer cost");
    expect(redactReason("257.500000 USDC")).toBe("[amount]");
    expect(redactReason("1,000.50 USDC in")).toBe("[amount] in");
    expect(redactReason("USDC 257.50")).toBe("[amount]");
    expect(redactReason("€12")).toBe("[amount]");
    expect(redactReason("a $1,000.50 fee, EUR 12 and usd9")).toBe("a [amount] fee, [amount] and [amount]");
    expect(redactReason(`USD 0x${"1".repeat(40)}`)).toBe("USD [address]");
    expect(redactReason("cost 1000,50 PLN, or 1000 zł, or 380 usd and 12EURC; sweep 20% of it")).toBe("cost [amount], or [amount], or [amount] and [amount]; sweep 20% of it");
    expect(redactReason("Order 12 is paid")).toBe("Order 12 is paid");
    for (const keep of ["2026-10-08", "1500.000000", "USDC only", "20 USDCx"]) expect(redactReason(keep)).toBe(keep);
    expect(redactReason("call 600 123 456")).toBe("call [phone]");
  });

  it("counts money in and out and decisions made against escalated", async () => {
    const get = async () => (await SELF.fetch("https://swagpay.test/api/metrics")).json<{
      orders: Record<string, number>; received: { USDC: string }; paidOut: { USDC: string }; obligations: { settledByAgent: number; settledWithOwner: number; open: number }; decisions: { total: number; escalated: number };
    }>();
    const before = await get();
    const { order } = await newOrderRow();
    await env.DB.prepare("INSERT INTO transfers (tx_hash, log_index, block_number, token, from_address, amount_units, request_id, created_at) VALUES (?, 0, 1, 'USDC', '0x2', 5000000, NULL, ?)")
      .bind(`0x${"e".repeat(64)}`, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO obligations (order_id, kind, token, amount_units, destination, chain, due_at, status, source_ref, created_at) VALUES (?, 'printer_cost', 'USDC', 2000000, '0x3', 'ARC', ?, 'paid', ?, ?)")
      .bind(order.id, new Date().toISOString(), `metrics:${crypto.randomUUID()}`, new Date().toISOString()).run();
    const ob = await env.DB.prepare("SELECT id FROM obligations ORDER BY id DESC LIMIT 1").first<{ id: number }>();
    await env.DB.prepare("INSERT INTO payouts (obligation_id, method, chain, token, amount_units, destination, idempotency_key, status, created_at, updated_at) VALUES (?, 'transfer', 'ARC', 'USDC', 2000000, '0x3', ?, 'sent', ?, ?)")
      .bind(ob!.id, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()).run();
    // Settled with the owner: paid after the owner's approval, or settled by the owner by hand.
    for (const [status, by] of [["paid", "owner"], ["settled", null], ["settled", "owner"]] as const) {
      await env.DB.prepare("INSERT INTO obligations (order_id, kind, token, amount_units, destination, chain, due_at, status, approved_by, source_ref, created_at) VALUES (?, 'refund', 'USDC', 1000000, '0x3', 'ARC', ?, ?, ?, ?, ?)")
        .bind(order.id, new Date().toISOString(), status, by, `metrics:${crypto.randomUUID()}`, new Date().toISOString()).run();
    }
    await insertDecision(env.DB, { orderId: order.id, tool: "escalate", reason: "discount asked", input: {}, verdict: "escalate", outcome: "escalated" });
    const m = await get();
    const d6 = (a: string, b: string) => Math.round((Number(a) - Number(b)) * 1e6) / 1e6;
    expect(m.orders.draft).toBeGreaterThanOrEqual(1);
    expect(d6(m.received.USDC, before.received.USDC)).toBe(0);
    expect(d6(m.paidOut.USDC, before.paidOut.USDC)).toBe(2);
    expect(m.obligations.settledByAgent - before.obligations.settledByAgent).toBe(1);
    expect(m.obligations.settledWithOwner - before.obligations.settledWithOwner).toBe(3);
    expect(m.obligations.open - before.obligations.open).toBe(0);
    expect(m.decisions.escalated - before.decisions.escalated).toBe(1);
    expect(m.decisions.total).toBeGreaterThanOrEqual(m.decisions.escalated);
  });
});

describe("renderLog", () => {
  it("shows an empty state and money with two decimals", () => {
    const html = renderLog([], {
      orders: {}, received: { USDC: "1234.500000", EURC: "0.000000" }, paidOut: { USDC: "0.000000", EURC: "0.000000" },
      obligations: { settledByAgent: 0, settledWithOwner: 0, open: 0 }, decisions: { total: 0, escalated: 0, blocked: 0 },
    });
    expect(html).toContain("No decisions yet.");
    expect(html).toContain("<strong>1234.50</strong>");
    expect(html).toContain("Escalated to the owner");
  });
});
