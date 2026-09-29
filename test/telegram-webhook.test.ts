import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { createOrder } from "../src/db";
import { createEscalation, getEscalation } from "../src/escalations";
import { IntakeSchema } from "../src/intake";
import { handleTelegram } from "../src/telegram-webhook";
import type { TelegramClient } from "../src/telegram";

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
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved.`);
  });

  it("re-sends a decision, and refuses strict-id violations", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id} is still open.`);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[2]).toBe(`#${e.id} re-sent to the agent (approved).`);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox.split(`Owner decision on escalation #${e.id}`).length - 1).toBe(2);
    });
    await handleTelegram(update(fromOwner("/approve 1e2")), env, t);
    expect(t.sent[3]).toBe("Usage: /approve <id> [note]");
  });

  it("handles the Reject button", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update({ callback_query: { id: "cb9", data: `esc:${e.id}:reject`, message: { chat: { id: 42 } } } }), env, t);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("rejected");
    expect(t.answered).toEqual([`cb9:#${e.id} rejected.`]);
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
});
