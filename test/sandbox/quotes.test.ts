import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../../src/agent/order-agent";
import { handleApi } from "../../src/api";
import { createOrder, saveOrderSpec } from "../../src/db";
import { createEscalation, getEscalation } from "../../src/escalations";
import { cleanupSandbox } from "../../src/sandbox/cleanup";
import type { SandboxOwnerState } from "../../src/sandbox/owner-api";
import { SIMULATED } from "../../src/sandbox/printer";
import { REPLY_EXPIRY_SECONDS, arrivalDate, replyPlan, repliesEvent } from "../../src/sandbox/quotes";
import type { VendorRow } from "../../src/vendors";
import { completeSpec, intakeFor, newOrderRow } from "../fixtures";

const sandbox = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002" } as unknown as Env;
type Escalator = { escalateOnce(orderId: number, key: string, kind: string, summary: string, payload: unknown): Promise<{ id: number }> };

async function addVendor(name: string, status = "screened", extra: { leadDays?: string } = {}): Promise<number> {
  return (await env.DB
    .prepare("INSERT INTO vendors (name, city, country, methods, status, lead_days, source_ref, created_at, updated_at) VALUES (?, 'Gdańsk', 'PL', '[\"screen\",\"diecut\"]', ?, ?, ?, 'x', 'x') RETURNING id")
    .bind(name, status, extra.leadDays ?? null, `test:${crypto.randomUUID()}`)
    .first<{ id: number }>())!.id;
}

/** A vendor whose reply plan for this order matches `pred` (the plan is a fixed hash of order and printer). */
async function vendorWhere(orderId: number, pred: (p: ReturnType<typeof replyPlan>) => boolean): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const id = await addVendor(`Reply Vendor ${i}`);
    if (pred(replyPlan(orderId, id))) return id;
  }
  throw new Error("no vendor matched");
}

/** An initialised order with a complete spec whose agent runs as the sandbox (or production), and a cost request the agent knows. */
async function costOrder(opts: { sandbox?: boolean } = {}) {
  const { order, token } = await newOrderRow();
  await saveOrderSpec(env.DB, order.id, completeSpec);
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intakeFor());
  let costId = 0;
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    if (opts.sandbox !== false) (agent as unknown as { env: Env }).env = sandbox;
    else (agent as unknown as { telegramOverride: unknown }).telegramOverride = { async send() { return null; }, async answerCallback() {} };
    costId = (await (agent as unknown as Escalator).escalateOnce(order.id, "cost:test", "cost", "Printer cost needed", { specKey: "test" })).id;
  });
  return { order, token, stub, costId };
}

const rows = async (escalationId: number) =>
  (await env.DB.prepare("SELECT id, vendor_id, status, offer_id, decline_reason FROM quote_requests WHERE escalation_id = ? ORDER BY id").bind(escalationId)
    .all<{ id: number; vendor_id: number; status: string; offer_id: number | null; decline_reason: string | null }>()).results;
const inbox = (agent: OrderAgent) => agent.sql<{ text: string }>`SELECT text FROM inbox WHERE kind = 'event'`.map((r) => r.text).filter((t) => t.startsWith("Printer replies"));

describe("reply plan", () => {
  it("is fixed per order and printer: 60–180 s, about one in four declining", () => {
    expect(replyPlan(7, 45)).toEqual(replyPlan(7, 45));
    let declines = 0;
    for (let o = 1; o <= 20; o++) {
      for (let v = 1; v <= 20; v++) {
        const p = replyPlan(o, v);
        expect(p.delaySeconds).toBeGreaterThanOrEqual(60);
        expect(p.delaySeconds).toBeLessThanOrEqual(180);
        if (p.declines) declines++;
      }
    }
    expect(declines / 400).toBeGreaterThan(0.15);
    expect(declines / 400).toBeLessThan(0.35);
  });

  it("dates the delivery 5 Polish working days ahead, or by the printer's lead days for the order's methods", () => {
    const friday = new Date("2026-10-09T10:00:00Z");
    expect(arrivalDate(friday, null, ["screen"])).toBe("2026-10-16");
    expect(arrivalDate(friday, { lead_days: '{"screen": 2, "diecut": 1}' } as VendorRow, ["screen", "diecut"])).toBe("2026-10-13");
    expect(arrivalDate(friday, { lead_days: '{"screen": "7-12 business days"}' } as VendorRow, ["screen"])).toBe("2026-10-16");
  });
});

describe("asking printers", () => {
  it("asks verified printers in the sandbox, schedules each reply and one expiry, and refuses bad picks without writing", async () => {
    const { stub, costId } = await costOrder();
    const a = await addVendor("Ask A");
    const b = await addVendor("Ask B", "partner");
    const cand = await addVendor("Ask C", "candidate");
    const paused = await addVendor("Ask D", "paused");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const bad = await agent.askPrinters(costId, [a, cand, paused, 999_999]);
      expect(bad).toEqual({ asked: [], refused: [`printer #${cand} isn't verified`, `printer #${paused} is paused`, "printer #999999 doesn't exist"], sandbox: true });
      expect(await agent.askPrinters(costId, [a, b])).toEqual({ asked: [a, b], refused: [], sandbox: true });
      const s = agent.getSchedules();
      const replies = s.filter((x) => x.callback === "sandboxQuoteReply");
      expect(replies).toHaveLength(2);
      expect(replies[0].payload).toMatchObject({ cityKey: "warszawa" }); // from the delivery place (no find_printers city yet)
      const expiry = s.filter((x) => x.callback === "sandboxQuoteExpiry");
      expect(expiry).toHaveLength(1);
      expect(expiry[0].payload).toEqual({ escalationId: costId });
      expect(Math.abs(expiry[0].time - (Date.now() / 1000 + REPLY_EXPIRY_SECONDS))).toBeLessThan(5);
      expect((await agent.askPrinters(costId, [a])).refused).toEqual([`printer #${a} was already asked for this cost request`]);
      expect((await agent.askPrinters(costId, [b, b])).refused).toContain(`printer #${b} is listed twice`);
    });
    expect((await rows(costId)).map((r) => [r.vendor_id, r.status])).toEqual([[a, "asked"], [b, "asked"]]);
  });

  it("asks at most 6 printers per cost request", async () => {
    const { stub, costId } = await costOrder();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await addVendor(`Six ${i}`));
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect((await agent.askPrinters(costId, ids.slice(0, 3))).refused).toEqual([]);
      expect((await agent.askPrinters(costId, ids.slice(3, 6))).refused).toEqual([]);
      expect((await agent.askPrinters(costId, [ids[6]])).refused).toEqual(["at most 6 printers per cost request (6 already asked)"]);
    });
  });

  it("drafts the requests for the owner in production and schedules nothing", async () => {
    const { stub, costId } = await costOrder({ sandbox: false });
    const a = await addVendor("Draft A");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(await agent.askPrinters(costId, [a])).toEqual({ asked: [a], refused: [], sandbox: false });
      expect(agent.getSchedules().filter((x) => x.callback.startsWith("sandboxQuote"))).toEqual([]);
    });
    expect((await rows(costId)).map((r) => r.status)).toEqual(["drafted"]);
  });
});

describe("simulated replies", () => {
  it("turns replies into offers and tells the agent once, when every printer has answered", async () => {
    const { order, stub, costId } = await costOrder();
    const replier = await vendorWhere(order.id, (p) => !p.declines);
    const decliner = await vendorWhere(order.id, (p) => p.declines);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.askPrinters(costId, [replier, decliner]);
      const [first, second] = await rows(costId);
      await agent.sandboxQuoteReply({ quoteRequestId: first.id });
      expect(inbox(agent)).toEqual([]);
      await agent.sandboxQuoteReply({ quoteRequestId: second.id });
      await agent.sandboxQuoteReply({ quoteRequestId: second.id }); // a repeat does nothing
      await agent.sandboxQuoteExpiry({ escalationId: costId }); // nothing left to expire, nothing new to tell
      const events = inbox(agent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatch(new RegExp(
        `^Printer replies for cost request #${costId} \\(simulated\\): offer #\\d+ from printer #${replier}: \\d+\\.\\d{2} PLN landed \\(parcel locker, arrives \\d{4}-\\d{2}-\\d{2}, on time; 2 delivery options\\); printer #${decliner} declined: [a-z' ]+\\. The owner chooses one of these offers; tell the host the price is on its way\\.$`,
      ));
      expect(events[0]).not.toContain("Reply Vendor");
      expect(agent.sql<{ text: string }>`SELECT text FROM thread`.map((r) => r.text)).toContain("Printers replied with quotes (simulated).");
    });
    const [r1, r2] = await rows(costId);
    expect(r1).toMatchObject({ status: "replied" });
    expect(r2).toMatchObject({ status: "declined" });
    const offer = await env.DB.prepare("SELECT * FROM printer_offers WHERE id = ?").bind(r1.offer_id).first<{ vendor_id: number; currency: string; note: string; delivery_cents: number }>();
    // Gdańsk printer, Warsaw delivery: courier or parcel locker; the cheapest on time is the default.
    expect(offer).toMatchObject({ vendor_id: replier, currency: "PLN", delivery_cents: 15 });
    expect(offer!.note).toContain(SIMULATED);
    const opts = (await env.DB.prepare("SELECT id, method, cost_cents, arrives_at FROM offer_deliveries WHERE offer_id = ? ORDER BY id").bind(r1.offer_id).all<{ id: number; method: string; cost_cents: number; arrives_at: string }>()).results;
    expect(opts.map((o) => [o.method, o.cost_cents])).toEqual([["courier", 25], ["parcel_locker", 15]]);
    expect(await env.DB.prepare("SELECT delivery_method, delivery_id, arrives_at FROM printer_offers WHERE id = ?").bind(r1.offer_id).first())
      .toEqual({ delivery_method: "parcel_locker", delivery_id: opts[1].id, arrives_at: opts[1].arrives_at });
  });

  it("offers pickup and same-day for a printer in the delivery city", async () => {
    const { order, stub, costId } = await costOrder();
    const replier = await vendorWhere(order.id, (p) => !p.declines);
    await env.DB.prepare("UPDATE vendors SET city = 'Warsaw' WHERE id = ?").bind(replier).run();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.askPrinters(costId, [replier]);
      await agent.sandboxQuoteReply({ quoteRequestId: (await rows(costId))[0].id, cityKey: "warszawa" });
    });
    const offerId = (await rows(costId))[0].offer_id;
    const methods = (await env.DB.prepare("SELECT method FROM offer_deliveries WHERE offer_id = ? ORDER BY id").bind(offerId).all<{ method: string }>()).results.map((r) => r.method);
    expect(methods).toEqual(["pickup", "same_day"]);
    expect((await env.DB.prepare("SELECT delivery_method FROM printer_offers WHERE id = ?").bind(offerId).first<{ delivery_method: string }>())?.delivery_method).toBe("pickup");
  });

  it("asks the agent to check the date with the host when no offer arrives in time", async () => {
    const { order, stub, costId } = await costOrder();
    await env.DB.prepare("UPDATE orders SET deliver_by = ? WHERE id = ?").bind(new Date(Date.now() + 86_400_000).toISOString(), order.id).run();
    const replier = await vendorWhere(order.id, (p) => !p.declines);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.askPrinters(costId, [replier]);
      await agent.sandboxQuoteReply({ quoteRequestId: (await rows(costId))[0].id });
      const [event] = inbox(agent);
      expect(event).toContain(", late; 2 delivery options)");
      expect(event).toMatch(/No offer arrives by the delivery date: ask the host whether a later date works\.$/);
    });
  });

  it("expires printers that haven't answered after 10 minutes and invites a second ask", async () => {
    const { stub, costId } = await costOrder();
    const slow = await addVendor("Slow");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.askPrinters(costId, [slow]);
      await agent.sandboxQuoteExpiry({ escalationId: costId });
      expect((await rows(costId))[0].status).toBe("asked"); // too young to expire
      await env.DB.prepare("UPDATE quote_requests SET created_at = ? WHERE escalation_id = ?").bind(new Date(Date.now() - 11 * 60_000).toISOString(), costId).run();
      await agent.sandboxQuoteExpiry({ escalationId: costId });
      expect(inbox(agent)).toEqual([
        `Printer replies for cost request #${costId} (simulated): printer #${slow} didn't reply in time. No offer this time. You may ask up to 5 other printers: call request_printer_cost with new printerIds (find_printers lists them). Otherwise tell the host a person will follow up.`,
      ]);
    });
    expect((await rows(costId))[0].status).toBe("expired");
  });
});

it("waits for a reply whose offer is still being written", async () => {
  const { order } = await newOrderRow();
  const e = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "x", payload: {} });
  const v = await addVendor("Mid Reply");
  await env.DB.prepare("INSERT INTO quote_requests (order_id, escalation_id, vendor_id, status, created_at, settled_at) VALUES (?, ?, ?, 'replied', 'x', 'x')").bind(order.id, e.id, v).run();
  expect(await repliesEvent(sandbox, e.id)).toBeNull();
  const offer = await env.DB.prepare("INSERT INTO printer_offers (order_id, vendor_id, currency, price_cents, delivery_cents, other_cents, arrives_at, created_at) VALUES (?, ?, 'PLN', 1500, 0, 0, '2099-01-01', 'x') RETURNING id").bind(order.id, v).first<{ id: number }>();
  await env.DB.prepare("UPDATE quote_requests SET offer_id = ? WHERE escalation_id = ?").bind(offer!.id, e.id).run();
  expect(await repliesEvent(sandbox, e.id)).toContain(`offer #${offer!.id} from printer #${v}: 15.00 PLN landed`);
});

describe("owner panel", () => {
  const get = (token: string) => handleApi(new Request(`https://sandbox.test/api/o/${token}/sandbox/owner`), sandbox);
  const post = (token: string, action: string, body: unknown) =>
    handleApi(new Request(`https://sandbox.test/api/o/${token}/sandbox/owner/${action}`, { method: "POST", body: JSON.stringify(body) }), sandbox);

  it("shows the asked printers with their offers and lets the judge use one", async () => {
    const { order, token, stub, costId } = await costOrder();
    const replier = await vendorWhere(order.id, (p) => !p.declines);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.askPrinters(costId, [replier]);
      await agent.sandboxQuoteReply({ quoteRequestId: (await rows(costId))[0].id });
    });
    const st = await (await get(token)).json<SandboxOwnerState>();
    expect(st.cost?.escalationId).toBe(costId);
    expect(st.cost?.quoteRequests).toEqual([{
      vendorId: replier, name: expect.stringContaining("Reply Vendor"), city: "Gdańsk", status: "replied", declineReason: null,
      offer: {
        offerId: expect.any(Number), currency: "PLN", amount: expect.any(Number), landedPln: expect.any(Number), arrivesAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), late: false, used: false,
        deliveries: [
          { deliveryId: expect.any(Number), method: "courier", cost: 0.25, currency: "PLN", arrivesAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), late: false, chosen: false },
          { deliveryId: expect.any(Number), method: "parcel_locker", cost: 0.15, currency: "PLN", arrivesAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), late: false, chosen: false },
        ],
      },
    }]);
    const offerId = st.cost!.quoteRequests[0].offer!.offerId;
    const courier = st.cost!.quoteRequests[0].offer!.deliveries[0].deliveryId;
    const res = await (await post(token, "use_offer", { offerId, deliveryId: courier })).json<{ ok: boolean; message: string }>();
    expect(res.ok).toBe(true);
    const used = (await (await get(token)).json<SandboxOwnerState>());
    expect(used.cost).toBeNull(); // decided
    expect(await env.DB.prepare("SELECT delivery_method FROM printer_offers WHERE id = ?").bind(offerId).first()).toEqual({ delivery_method: "courier" });
    expect((await getEscalation(env.DB, costId))?.status).not.toBe("open");
    expect((await env.DB.prepare("SELECT chosen_at FROM printer_offers WHERE id = ?").bind(offerId).first<{ chosen_at: string | null }>())?.chosen_at).not.toBeNull();
  });

  it("refuses an offer from another order and a malformed one", async () => {
    const mine = await costOrder();
    const other = await costOrder();
    const replier = await vendorWhere(other.order.id, (p) => !p.declines);
    await runInDurableObject(other.stub, async (agent: OrderAgent) => {
      await agent.askPrinters(other.costId, [replier]);
      await agent.sandboxQuoteReply({ quoteRequestId: (await rows(other.costId))[0].id });
    });
    const offerId = (await rows(other.costId))[0].offer_id;
    expect((await post(mine.token, "use_offer", { offerId })).status).toBe(404);
    expect((await post(mine.token, "use_offer", { offerId: "1" })).status).toBe(400);
    expect((await post(other.token, "use_offer", { offerId, deliveryId: "x" })).status).toBe(400);
  });
});

it("sandbox cleanup deletes an order's quote requests", async () => {
  const { order } = await createOrder(env.DB, intakeFor(), new Date(Date.now() - 49 * 3_600_000));
  const e = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "x", payload: {} });
  const v = await addVendor("Old");
  await env.DB.prepare("INSERT INTO quote_requests (order_id, escalation_id, vendor_id, status, created_at) VALUES (?, ?, ?, 'asked', 'x')").bind(order.id, e.id, v).run();
  const offer = await env.DB.prepare("INSERT INTO printer_offers (order_id, vendor_id, currency, price_cents, delivery_cents, other_cents, arrives_at, created_at) VALUES (?, ?, 'PLN', 100, 0, 0, '2099-01-01', 'x') RETURNING id").bind(order.id, v).first<{ id: number }>();
  await env.DB.prepare("INSERT INTO offer_deliveries (offer_id, method, cost_cents, arrives_at, created_at) VALUES (?, 'courier', 25, '2099-01-03', 'x')").bind(offer!.id).run();
  await cleanupSandbox(sandbox);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM offer_deliveries WHERE offer_id = ?").bind(offer!.id).first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE order_id = ?").bind(order.id).first<{ n: number }>())?.n).toBe(0);
});
