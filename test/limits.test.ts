import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { handleApi } from "../src/api";
import { SANDBOX_BUDGET_TEXT, clientKey, sandboxBudgetLeft, takeModelCall } from "../src/limits";
import { intakeFor, newOrderRow } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const intake = {
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
};
const create = (e: Env, ip: string, key?: string) =>
  handleApi(new Request("https://swagpay.test/api/orders", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ ...intake, ...(key ? { idempotencyKey: key } : {}) }),
  }), e);

describe("per-client order limit", () => {
  const capped = { ...env, CLIENT_HASH_SALT: "test-salt", ORDERS_PER_CLIENT_PER_DAY: "2" } as unknown as Env;

  it("allows two new orders a day per client, then refuses with 429", async () => {
    expect((await create(capped, "203.0.113.7", "client-limit-key-0001")).status).toBe(201);
    expect((await create(capped, "203.0.113.7")).status).toBe(201);
    const third = await create(capped, "203.0.113.7");
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "You've started the most orders allowed today. Continue one of them, or come back tomorrow." });
    expect((await create(capped, "198.51.100.9")).status).toBe(201);
    // A retry of a create that already succeeded still gets its order.
    expect((await create(capped, "203.0.113.7", "client-limit-key-0001")).status).toBe(200);
  });

  it("is off without CLIENT_HASH_SALT", async () => {
    const off = { ...env, ORDERS_PER_CLIENT_PER_DAY: "1" } as unknown as Env;
    expect((await create(off, "192.0.2.44")).status).toBe(201);
    expect((await create(off, "192.0.2.44")).status).toBe(201);
  });

  it("keys a client by a salted hash of its IP and the day", async () => {
    const salted = { ...env, CLIENT_HASH_SALT: "test-salt" } as unknown as Env;
    const k = await clientKey(salted, "203.0.113.7", "2099-10-09");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("203");
    expect(await clientKey(salted, "203.0.113.7", "2099-10-09")).toBe(k);
    expect(await clientKey(salted, "203.0.113.7", "2099-10-10")).not.toBe(k);
    expect(await clientKey({ ...salted, CLIENT_HASH_SALT: "other" } as unknown as Env, "203.0.113.7", "2099-10-09")).not.toBe(k);
    expect(await clientKey(salted, null, "2099-10-09")).toBeNull();
    expect(await clientKey(env, "203.0.113.7", "2099-10-09")).toBeNull();
  });
});

describe("sandbox model budget", () => {
  const sb = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002", SANDBOX_DAILY_MODEL_CALLS: "2" } as unknown as Env;

  it("takes calls until the day's budget is spent; production never counts", async () => {
    const day = new Date("2099-01-02T10:00:00Z");
    expect(await sandboxBudgetLeft(sb, day)).toBe(true);
    expect(await takeModelCall(sb, day)).toBe(true);
    expect(await takeModelCall(sb, day)).toBe(true);
    expect(await takeModelCall(sb, day)).toBe(false);
    expect(await sandboxBudgetLeft(sb, day)).toBe(false);
    expect(await takeModelCall(env, day)).toBe(true);
    expect(await sandboxBudgetLeft(env, day)).toBe(true);
    expect((await env.DB.prepare("SELECT n FROM model_calls_daily WHERE day = '2099-01-02'").first<{ n: number }>())?.n).toBe(2);
    expect(await takeModelCall({ ...sb, SANDBOX_DAILY_MODEL_CALLS: "0" } as unknown as Env, new Date("2099-01-03T10:00:00Z"))).toBe(false);
  });

  it("stops the order agent before the model, says so once, and keeps the messages", async () => {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intakeFor());
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      (agent as unknown as { env: Env }).env = { ...sb, SANDBOX_DAILY_MODEL_CALLS: "0" } as unknown as Env;
      const model = scriptedModel([]);
      agent.modelOverride = model;
      expect(await agent.processTurn()).toBeNull();
      expect(await agent.processTurn()).toBeNull();
      expect(model.requests).toHaveLength(0);
      expect((await agent.getView()).thread.filter((t) => t.text === SANDBOX_BUDGET_TEXT)).toHaveLength(1);
      expect(agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM inbox`[0].n).toBe(2);
    });
  });

  it("stops mid-turn when the budget runs out, without telling the owner", async () => {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intakeFor());
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const one = { ...sb, SANDBOX_DAILY_MODEL_CALLS: "1" } as unknown as Env;
      await env.DB.prepare("DELETE FROM model_calls_daily").run();
      (agent as unknown as { env: Env }).env = one;
      const model = scriptedModel([msg([toolUse("ask_host", { message: "Which sizes?", reason: "size split missing" })], "tool_use"), msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.processTurn();
      expect(model.requests).toHaveLength(1);
      expect((await agent.getView()).thread.map((t) => t.text)).toContain(SANDBOX_BUDGET_TEXT);
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM escalations WHERE order_id = ? AND kind = 'system'").bind(order.id).first<{ n: number }>())?.n).toBe(0);
  });
});

it("still ignores an overlapping turn in the sandbox while the budget is read", async () => {
  const { order } = await newOrderRow();
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intakeFor());
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    (agent as unknown as { env: Env }).env = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002", SANDBOX_DAILY_MODEL_CALLS: "600" } as unknown as Env;
    const model = scriptedModel([msg([], "end_turn")]);
    agent.modelOverride = model;
    const [a, b] = await Promise.all([agent.processTurn(), agent.processTurn()]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });
});

describe("per-order caps", () => {
  it("follow MAX_MODEL_CALLS_PER_ORDER and MAX_HOST_MESSAGES_PER_ORDER", async () => {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intakeFor());
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      (agent as unknown as { env: Env }).env = { ...env, MAX_MODEL_CALLS_PER_ORDER: "1", MAX_HOST_MESSAGES_PER_ORDER: "1" } as unknown as Env;
      agent.telegramOverride = { async send() { return 1; }, async answerCallback() {} };
      const model = scriptedModel([msg([toolUse("ask_host", { message: "Which sizes?", reason: "size split missing" })], "tool_use"), msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.processTurn();
      expect(model.requests).toHaveLength(1);
      expect((await agent.getView()).thread.map((t) => t.text)).toContain("This order has reached the agent's limit. The owner will continue it personally.");
      await expect(agent.postHostMessage("one more")).rejects.toThrow("message limit reached");
    });
  });
});
