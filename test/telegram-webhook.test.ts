import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { createOrder, getOrderById } from "../src/db";
import { createEscalation, getEscalation, listEscalations } from "../src/escalations";
import { IntakeSchema } from "../src/intake";
import { listPaymentRequests } from "../src/payments";
import { handleTelegram } from "../src/telegram-webhook";
import type { TelegramClient } from "../src/telegram";
import { completeSpec, insertQuote, newOrderRow } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const intake = IntakeSchema.parse({
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
});

function fakeTelegram() {
  const sent: string[] = [];
  const answered: string[] = [];
  const telegram: TelegramClient = {
    async send(_chat, text) { sent.push(text); return 1; },
    async answerCallback(id, text) { answered.push(`${id}:${text}`); },
  };
  return { sent, answered, telegram };
}

const update = (body: unknown, secret = "test-secret") =>
  new Request("https://swagpay.test/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });
const fromOwner = (text: string) => ({ message: { chat: { id: 42 }, text } });

async function orderWithEscalation() {
  const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intake);
  const e = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: banner", payload: {} });
  return { order, stub, e };
}

describe("Telegram webhook", () => {
  async function paidDepositOrder(o: { priceCents?: number; depositCents?: number } = {}) {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intake);
    const quoteId = await insertQuote(env.DB, order.id, { priceCents: o.priceCents ?? 38000, depositCents: o.depositCents ?? 25750 });
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(quoteId).run();
    await env.DB.prepare("UPDATE orders SET status = 'deposit_paid' WHERE id = ?").bind(order.id).run();
    return { order, stub, quoteId };
  }

  it("/printed sends the balance request once", async () => {
    const { order, stub } = await paidDepositOrder();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[0]).toMatch(new RegExp(`^Order ${order.id}: printed; balance request #\\d+ for 122\\.50\\d{4} USDC is on the order page\\.$`));
    const requests = (await listPaymentRequests(env.DB, order.id)).filter((r) => r.stage === "balance");
    expect(requests).toHaveLength(1);
    expect(Math.floor(requests[0].amount_units / 10_000)).toBe(12250);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_pending");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Balance request #${requests[0].id}`);
    });
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[1]).toBe(`Order ${order.id} is balance_pending; /printed works once the deposit is paid.`);
    expect((await listPaymentRequests(env.DB, order.id)).filter((r) => r.stage === "balance")).toHaveLength(1);
  });

  it("/printed with nothing left to pay marks the order paid", async () => {
    const { order } = await paidDepositOrder({ priceCents: 25750, depositCents: 25750 });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[0]).toBe(`Order ${order.id}: printed; nothing more is due.`);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_paid");
  });

  it("rejects a wrong secret and ignores other chats", async () => {
    const t = fakeTelegram();
    expect((await handleTelegram(update(fromOwner("/open"), "nope"), env, t)).status).toBe(401);
    const { e } = await orderWithEscalation();
    const res = await handleTelegram(update({ message: { chat: { id: 7 }, text: `/approve ${e.id}` } }), env, t);
    expect(res.status).toBe(200);
    expect(t.sent).toEqual([]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });

  it("is off without a webhook secret", async () => {
    const off = { ...env, TELEGRAM_WEBHOOK_SECRET: "" } as Env;
    expect((await handleTelegram(update(fromOwner("/open")), off, fakeTelegram())).status).toBe(404);
  });

  it("lists open escalations", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner("/open")), env, t);
    expect(t.sent[0]).toContain(`#${e.id}`);
    expect(t.sent[0]).toContain("Approve: banner");
  });

  it("approves with a note, tells the agent, and refuses a second decision", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/approve ${e.id} fine for this event`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id} approved.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", decision_note: "fine for this event" });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox).toContain(`Owner decision on escalation #${e.id} (summary: "Approve: banner"): approved.`);
      expect(inbox).toContain('Note from the owner: "fine for this event"');
    });
    expect((await getEscalation(env.DB, e.id))?.delivered_at).toBeTruthy();
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved.`);
  });

  it("re-sends a decision, and refuses strict-id violations", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id} is still open.`);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} approved.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[2]).toBe(`#${e.id} was already delivered to the agent.`);
    await env.DB.prepare("UPDATE escalations SET delivered_at = NULL WHERE id = ?").bind(e.id).run();
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[3]).toBe(`#${e.id} re-sent to the agent (approved).`);
    expect((await getEscalation(env.DB, e.id))?.delivered_at).toBeTruthy();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox.split(`Owner decision on escalation #${e.id}`).length - 1).toBe(2);
    });
    await handleTelegram(update(fromOwner("/approve 1e2")), env, t);
    expect(t.sent[4]).toBe("Usage: /approve <id> [note]");
  });

  it("handles the Reject button", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update({ callback_query: { id: "cb9", data: `esc:${e.id}:reject`, message: { chat: { id: 42 } } } }), env, t);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("rejected");
    expect(t.answered).toEqual([`cb9:#${e.id} rejected.`]);
    expect(t.sent).toEqual([`#${e.id} rejected.`]);
  });

  it("says a system notice was acknowledged", async () => {
    const { order } = await orderWithEscalation();
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "system", summary: "Order failed", payload: {} });
    const t = fakeTelegram();
    await handleTelegram(update({ callback_query: { id: "cb1", data: `esc:${e.id}:approve`, message: { chat: { id: 42 } } } }), env, t);
    expect(t.answered).toEqual([`cb1:#${e.id} acknowledged.`]);
    expect(t.sent).toEqual([`#${e.id} acknowledged.`]);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already acknowledged.`);
  });

  it("ignores buttons from other chats and crafted button data", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    const other = await handleTelegram(update({ callback_query: { id: "cb2", data: `esc:${e.id}:approve`, message: { chat: { id: 7 } } } }), env, t);
    expect(other.status).toBe(200);
    expect(t.answered).toEqual([]);
    expect(t.sent).toEqual([]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    await handleTelegram(update({ callback_query: { id: "cb3", data: `esc:${e.id}:approved`, message: { chat: { id: 42 } } } }), env, t);
    expect(t.answered).toEqual(["cb3:Unknown button."]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });

  it("lists decisions the agent hasn't heard under /open", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    await env.DB.prepare("UPDATE escalations SET delivered_at = NULL WHERE id = ?").bind(e.id).run();
    await handleTelegram(update(fromOwner("/open")), env, t);
    expect(t.sent[1]).toContain(`#${e.id} approved — agent not told yet: /resend ${e.id}`);
  });

  it("keeps a decision the agent couldn't hear, and says how to retry", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    const down = ({ ...env, OrderAgent: unreachable }) as Env;
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), down, t);
    expect(t.sent[0]).toBe(`#${e.id} approved, but the agent could not be told. Send /resend ${e.id} to retry.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", delivered_at: null });
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), down, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved. The agent has not been told yet: send /resend ${e.id}.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), down, t);
    expect(t.sent[2]).toBe(`#${e.id}: the agent could not be told. Try /resend ${e.id} again later.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[3]).toBe(`#${e.id} re-sent to the agent (approved).`);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox.split(`Owner decision on escalation #${e.id}`).length - 1).toBe(1);
    });
  });

  it("offers /resend for an undelivered decision that has no order (a treasury escalation)", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "agent", summary: "Treasury: wallet low", payload: { treasury: true } });
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["TreasuryAgent"];
    const down = ({ ...env, TreasuryAgent: unreachable }) as Env;
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), down, t);
    expect(t.sent[0]).toBe(`#${e.id} approved, but the agent could not be told. Send /resend ${e.id} to retry.`);
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), down, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved. The agent has not been told yet: send /resend ${e.id}.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[2]).toBe(`#${e.id} re-sent to the agent (approved).`);
  });

  it("answers a failing command instead of erroring", async () => {
    const { order } = await orderWithEscalation();
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    const res = await handleTelegram(update(fromOwner(`/order ${order.id}`)), ({ ...env, OrderAgent: unreachable }) as Env, t);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(t.sent).toEqual(["Something went wrong: agent unreachable"]);
  });

  it("shows an order's status and answers anything else with help", async () => {
    const { order } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/order ${order.id}`)), env, t);
    expect(t.sent[0]).toContain(`Order ${order.id} · Builders meetup`);
    expect(t.sent[0]).toContain("Still missing:");
    await handleTelegram(update(fromOwner("hello")), env, t);
    expect(t.sent[1]).toContain("/approve <id> [note]");
    await handleTelegram(update(fromOwner("/approve abc")), env, t);
    expect(t.sent[2]).toBe("Usage: /approve <id> [note]");
  });

  it("is routed by the Worker", async () => {
    const res = await SELF.fetch(update(fromOwner("/help")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  async function orderWithCostRequest() {
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.telegramOverride = { async send() { return 1; }, async answerCallback() {} };
      await agent.init(order.id, intake);
      agent.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(completeSpec)})`;
      agent.modelOverride = scriptedModel([msg([toolUse("request_printer_cost", { reason: "order complete" })], "tool_use"), msg([], "end_turn")]);
      await agent.processTurn();
    });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.order_id === order.id && x.kind === "cost")!;
    return { order, stub, e };
  }

  it("records a cost with /cost and tells the agent", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1200,50 Drukarnia X`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id}: 1200.50 PLN recorded for order ${order.id}.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", decision_note: "1200.50 PLN; Drukarnia X" });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ cost_grosze: number }>`SELECT cost_grosze FROM printer_costs`[0].cost_grosze).toBe(120050);
    });
    await handleTelegram(update(fromOwner(`/cost ${e.id} 900`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved.`);
  });

  it("asks again instead of recording an amount written with a thousands separator", async () => {
    const { e, stub } = await orderWithCostRequest();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1 200,50 Drukarnia X`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 12 500`)), env, t);
    expect(t.sent).toEqual([
      `Did you mean 1200,50? Write the amount without spaces, e.g. /cost ${e.id} 1200.50`,
      `Did you mean 12500? Write the amount without spaces, e.g. /cost ${e.id} 1200.50`,
    ]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM printer_costs`[0].n).toBe(0);
    });
  });

  it("refuses bad amounts, other kinds and a plain approve on a cost request", async () => {
    const { e } = await orderWithCostRequest();
    const other = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 12x`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 0`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${other.e.id} 100`)), env, t);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent).toEqual([
      "Usage: /cost <id> <PLN gross, delivery included> [note]",
      "Usage: /cost <id> <PLN gross, delivery included> [note]",
      `#${other.e.id} is not a cost request.`,
      `#${e.id} needs a price: /cost ${e.id} <PLN gross, delivery included> [note]`,
    ]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });
});
