import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  countOrdersSince, createOrder, getOrderById, getOrderByToken, insertDecision, listDecisions, saveOrderSpec, setOrderStatus,
} from "../src/db";
import { IntakeSchema } from "../src/intake";

const intake = IntakeSchema.parse({
  eventName: "Builders meetup", eventDate: "2026-10-08", deliverBy: "2026-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees and 500 stickers",
});

describe("db", () => {
  it("creates an order reachable by its token, storing only the token hash", async () => {
    const { order, token } = await createOrder(env.DB, intake, new Date("2026-10-01T10:00:00Z"));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(order.deliver_by).toBe("2026-10-08T15:00:00.000Z");
    expect(order.instance).toMatch(/^order-/);
    const stored = await env.DB.prepare("SELECT token_hash FROM orders WHERE id = ?").bind(order.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(token);
    expect((await getOrderByToken(env.DB, token))?.id).toBe(order.id);
    expect(await getOrderByToken(env.DB, "x".repeat(43))).toBeNull();
  });

  it("saves the spec and counts recent orders", async () => {
    // A far-future creation date keeps this independent of orders other test files create.
    const { order } = await createOrder(env.DB, intake, new Date("2090-01-01T10:00:00Z"));
    await saveOrderSpec(env.DB, order.id, { items: [], artwork: [], notes: "hi" });
    expect(JSON.parse((await getOrderById(env.DB, order.id))!.spec_json!)).toEqual({ items: [], artwork: [], notes: "hi" });
    expect(await countOrdersSince(env.DB, new Date("2090-01-01T00:00:00Z"))).toBeGreaterThanOrEqual(1);
    expect(await countOrdersSince(env.DB, new Date("2090-01-02T00:00:00Z"))).toBe(0);
  });

  it("freezes the spec once a quote was accepted", async () => {
    const { order } = await createOrder(env.DB, intake, new Date("2026-10-01T10:00:00Z"));
    await saveOrderSpec(env.DB, order.id, { items: [], artwork: [], notes: "draft" });
    await setOrderStatus(env.DB, order.id, ["draft"], "quoted");
    await saveOrderSpec(env.DB, order.id, { items: [], artwork: [], notes: "quoted" });
    await setOrderStatus(env.DB, order.id, ["quoted"], "deposit_pending");
    await expect(saveOrderSpec(env.DB, order.id, { items: [], artwork: [], notes: "late" })).rejects.toThrow("items are frozen: a quote was already accepted");
    expect(JSON.parse((await getOrderById(env.DB, order.id))!.spec_json!).notes).toBe("quoted");
  });

  it("logs decisions in order", async () => {
    const { order } = await createOrder(env.DB, intake, new Date("2026-10-01T10:00:00Z"));
    await insertDecision(env.DB, { orderId: order.id, tool: "ask_host", reason: "sizes missing", input: { message: "sizes?" }, verdict: "none", outcome: "done" });
    await insertDecision(env.DB, { orderId: order.id, tool: "update_order", reason: "banner requested", input: {}, verdict: "escalate", outcome: "escalated", detail: "not on list" });
    const rows = await listDecisions(env.DB, order.id);
    expect(rows.map((r) => [r.tool, r.verdict, r.outcome])).toEqual([
      ["ask_host", "none", "done"],
      ["update_order", "escalate", "escalated"],
    ]);
    expect(JSON.parse(rows[0].input_json)).toEqual({ message: "sizes?" });
  });
});
