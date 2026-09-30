import { env, runInDurableObject } from "cloudflare:test";
import type { OrderAgent } from "../src/agent/order-agent";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { addOffer, listOffers, rankOffers, useOffer } from "../src/offers";
import { createEscalation, getEscalation } from "../src/escalations";
import { vendorJobFor } from "../src/vendors";
import { intakeFor, newOrderRow } from "./fixtures";

const vendor = async (city = "Warsaw", status = "screened") =>
  (await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES ('P', ?, 'PL', '[]', ?, ?, 'x', 'x') RETURNING id").bind(city, status, `o:${crypto.randomUUID()}`).first<{ id: number }>())!.id;

describe("printer offers", () => {
  it("ranks by landed PLN cost, late offers last, unknown rates unranked", () => {
    const base = { id: 0, order_id: 1, vendor_id: 1, delivery_cents: 0, other_cents: 0, note: null, chosen_at: null, created_at: "x" };
    const plnPer = (c: string) => ({ PLN: 1, EUR: 4.3 } as Record<string, number>)[c] ?? null;
    const ranked = rankOffers([
      { ...base, id: 1, currency: "PLN", price_cents: 120_000, arrives_at: "2099-10-07" },
      { ...base, id: 2, currency: "EUR", price_cents: 20_000, delivery_cents: 3_000, arrives_at: "2099-10-06" }, // 230 EUR = 989 PLN
      { ...base, id: 3, currency: "PLN", price_cents: 50_000, arrives_at: "2099-10-09" }, // cheapest but late
      { ...base, id: 4, currency: "INR", price_cents: 1_000, arrives_at: "2099-10-05" },
    ], plnPer, "2099-10-08T15:00:00.000Z");
    expect(ranked.map((r) => [r.offer.id, r.landedGrosze, r.late])).toEqual([[2, 98_900, false], [1, 120_000, false], [3, 50_000, true], [4, null, false]]);
  });

  it("'Use this offer' records the landed cost like /cost and owes the printer price plus delivery", async () => {
    const { order } = await newOrderRow();
    // giveCost() tells the order's agent: it must exist, as in the /cost tests.
    const agent = await getAgentByName(env.OrderAgent, order.instance);
    await agent.init(order.id, intakeFor());
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('EUR', 4.3, '2099-09-30', ?)").bind(new Date().toISOString()).run();
    const v = await vendor("Lisbon");
    const cost = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    // The agent knows this cost request, as it does after request_printer_cost.
    await runInDurableObject(agent, async (a: OrderAgent) => { a.sql`INSERT INTO escalated (key, escalation_id) VALUES (${`cost:k-${cost.id}`}, ${cost.id})`; });
    const offer = await addOffer(env.DB, { orderId: order.id, vendorId: v, currency: "EUR", priceCents: 20_000, deliveryCents: 3_000, otherCents: 500, arrivesAt: "2099-10-06" });
    const reply = await useOffer(env, offer.id);
    expect(reply).toMatch(new RegExp(`^#${cost.id}: 1010\\.50 PLN recorded for order ${order.id}`));
    expect((await getEscalation(env.DB, cost.id))?.status).toBe("approved");
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: v, cost_currency: "EUR", cost_cents: 23_000 });
    expect((await listOffers(env.DB, order.id))[0].chosen_at).not.toBeNull();
    expect(await useOffer(env, offer.id)).toBe("This offer was already used.");
  });
});
