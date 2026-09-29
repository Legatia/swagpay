import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { createOrder, listDecisions } from "../src/db";
import { IntakeSchema } from "../src/intake";
import { msg, scriptedModel, toolUse } from "./helpers";

const intake = IntakeSchema.parse({
  eventName: "Builders meetup", eventDate: "2026-10-08", deliverBy: "2026-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
});

async function newAgent() {
  const { order } = await createOrder(env.DB, intake, new Date("2026-10-01T10:00:00Z"));
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  return { order, stub };
}

describe("OrderAgent", () => {
  it("turns the intake into the first turn and shows the agent's question to the host", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const model = scriptedModel([
        msg([toolUse("ask_host", { message: "Which sizes do you need?", reason: "size split missing" })], "tool_use"),
        msg([], "end_turn"),
      ]);
      agent.modelOverride = model;
      await agent.init(order.id, intake);
      const result = await agent.processTurn();
      expect(result?.status).toBe("waiting");
      const first = model.requests[0].messages[0];
      expect(first.role).toBe("user");
      expect(JSON.stringify(first.content)).toContain("<event>New order");
      expect(JSON.stringify(first.content)).toContain('Event name (from the host): \\"Builders meetup\\"');
      expect(JSON.stringify(first.content)).toContain('Host\'s first name (from the host): \\"Ana\\"');
      expect(JSON.stringify(first.content)).toContain("<host_message>60 black tees");
      const view = await agent.getView();
      expect(view.thread.map((t) => [t.from, t.text])).toEqual([
        ["host", "60 black tees with our logo and 500 stickers"],
        ["agent", "Which sizes do you need?"],
      ]);
      expect(view.busy).toBe(false);
    });
    const decisions = await listDecisions(env.DB, order.id);
    expect(decisions.map((d) => d.tool)).toEqual(["ask_host"]);
  });

  it("runs the queued turn from the Durable Object alarm", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.modelOverride = scriptedModel([
        msg([toolUse("ask_host", { message: "Which sizes do you need?", reason: "size split missing" })], "tool_use"),
        msg([], "end_turn"),
      ]);
      await agent.init(order.id, intake);
      await agent.queue("processTurn", null, { id: "turn" });
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const view = await agent.getView();
      expect(view.thread.map((t) => t.text)).toContain("Which sizes do you need?");
    });
  });

  it("returns null when there is nothing new", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.modelOverride = scriptedModel([msg([], "end_turn")]);
      await agent.init(order.id, intake);
      await agent.processTurn();
      expect(await agent.processTurn()).toBeNull();
    });
  });

  it("keeps a message sent during a turn in the inbox until the next turn", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      let sentDuring = false;
      const base = scriptedModel([
        msg([toolUse("ask_host", { message: "Sizes?", reason: "sizes missing" }, "t1")], "tool_use"),
        msg([], "end_turn"),
        msg([], "end_turn"),
      ]);
      agent.modelOverride = {
        async create(req) {
          if (!sentDuring) { sentDuring = true; await agent.postHostMessage("S 10, M 20"); }
          return base.create(req);
        },
      };
      await agent.init(order.id, intake);
      await agent.processTurn();
      // first turn: the new message must not appear between tool_use and tool_result
      const secondRequest = base.requests[1].messages;
      expect(JSON.stringify(secondRequest)).not.toContain("S 10, M 20");
      await agent.processTurn();
      const thirdRequest = base.requests[2].messages;
      expect(JSON.stringify(thirdRequest.at(-1))).toContain("<host_message>S 10, M 20</host_message>");
    });
  });

  it("enforces the host message caps", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      await expect(agent.postHostMessage("x".repeat(4001))).rejects.toThrow("message too long");
      for (let i = 0; i < 59; i++) await agent.postHostMessage(`m${i}`); // the intake request counts as the first
      await expect(agent.postHostMessage("one more")).rejects.toThrow("message limit reached");
    });
  });

  it("stops calling the model once the per-order budget is spent", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      agent.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('model_calls', '80')`;
      const model = scriptedModel([]);
      agent.modelOverride = model;
      expect(await agent.processTurn()).toBeNull();
      expect(model.requests).toHaveLength(0);
      expect((await agent.getView()).thread.at(-1)).toMatchObject({ from: "system" });
    });
  });

  it("logs a failed model call and tells the host without losing the inbox", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.modelOverride = { async create() { throw new Error("overloaded"); } };
      await agent.init(order.id, intake);
      expect(await agent.processTurn()).toBeNull();
      const model = scriptedModel([msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.postHostMessage("hello?");
      await agent.processTurn();
      const sent = JSON.stringify(model.requests[0].messages);
      expect(sent).toContain("60 black tees");
      expect(sent).toContain("hello?");
    });
    const decisions = await listDecisions(env.DB, order.id);
    expect(decisions.at(-1)).toMatchObject({ tool: "agent_run", outcome: "error" });
  });

  it("closes a dangling tool_use with error tool_results before the next inbox message", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      const dangling = { role: "assistant", content: [{ type: "tool_use", id: "tu_dangling", name: "ask_host", input: { message: "x", reason: "y" } }] };
      agent.sql`INSERT INTO conversation (message) VALUES (${JSON.stringify(dangling)})`;
      const model = scriptedModel([msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.processTurn();
      const sent = model.requests[0].messages;
      const i = sent.findIndex((m) => JSON.stringify(m).includes("tu_dangling") && m.role === "assistant");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(sent[i + 1]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_dangling", content: "Interrupted before the result was saved.", is_error: true }],
      });
      expect(sent[i + 2].role).toBe("user");
      expect(JSON.stringify(sent[i + 2].content)).toContain("<host_message>60 black tees");
    });
  });

  it("ignores an overlapping turn and keeps one tool_result per tool_use", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let first = true;
      const base = scriptedModel([
        msg([toolUse("ask_host", { message: "Sizes?", reason: "sizes missing" }, "t1")], "tool_use"),
        msg([], "end_turn"),
      ]);
      agent.modelOverride = { async create(req) { if (first) { first = false; await gate; } return base.create(req); } };
      await agent.init(order.id, intake);
      const p1 = agent.processTurn();
      expect(await agent.processTurn()).toBeNull();
      expect((await agent.getView()).busy).toBe(true);
      release();
      await p1;
      expect((await agent.getView()).busy).toBe(false);
      const rows = agent.sql<{ message: string }>`SELECT message FROM conversation ORDER BY id`.map((r) => JSON.parse(r.message));
      const uses = rows.flatMap((m) => (m.role === "assistant" ? m.content : [])).filter((b: { type: string }) => b.type === "tool_use");
      const results = rows.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content : [])).filter((b: { type: string }) => b.type === "tool_result");
      expect(uses).toHaveLength(1);
      expect(results).toHaveLength(1);
    });
  });

  it("resumes a turn that was cut off after the inbox was drained", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.modelOverride = { async create() { throw new Error("boom"); } };
      await agent.init(order.id, intake);
      expect(await agent.processTurn()).toBeNull();
      agent.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('turn_pending', '1')`;
      const model = scriptedModel([msg([], "end_turn")]);
      agent.modelOverride = model;
      expect(await agent.processTurn()).not.toBeNull();
      const last = model.requests[0].messages.at(-1)!;
      expect(last.role).toBe("user");
      expect(JSON.stringify(last.content)).toContain("<host_message>60 black tees");
      expect(model.requests[0].messages).toHaveLength(1);
      expect(agent.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'turn_pending'`[0].value).toBe("0");
    });
  });

  it("counts every model call and stops exactly at the budget", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      agent.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('model_calls', '79')`;
      const model = scriptedModel([
        msg([toolUse("ask_host", { message: "Sizes?", reason: "sizes missing" })], "tool_use"),
        msg([], "end_turn"),
      ]);
      agent.modelOverride = model;
      await agent.processTurn();
      expect(model.requests).toHaveLength(1);
      expect(agent.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'model_calls'`[0].value).toBe("80");
      expect((await agent.getView()).thread.at(-1)).toMatchObject({ from: "system", text: expect.stringContaining("limit") });
    });
    const decisions = await listDecisions(env.DB, order.id);
    expect(decisions.some((d) => d.reason === "per-order model call budget spent")).toBe(true);
  });

  it("keeps the inbox when the policy fails to load", async () => {
    const { order, stub } = await newAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      const proto = agent as unknown as { loadTurnPolicy: () => unknown };
      const original = proto.loadTurnPolicy;
      proto.loadTurnPolicy = () => { throw new Error("bad POLICY_FX_BUFFER"); };
      expect(await agent.processTurn()).toBeNull();
      proto.loadTurnPolicy = original;
      const model = scriptedModel([msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.processTurn();
      expect(JSON.stringify(model.requests[0].messages)).toContain("60 black tees");
    });
    const decisions = await listDecisions(env.DB, order.id);
    expect(decisions.at(-1)).toMatchObject({ tool: "agent_run", reason: "policy configuration invalid", outcome: "error" });
  });
  it("records a preview only once the tool result holding it is saved", async () => {
    const { order, stub } = await newAgent();
    const fileId = crypto.randomUUID();
    await env.ARTWORK.put(`artwork/${order.instance}/${fileId}`, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.init(order.id, intake);
      await agent.addArtwork({ fileId, name: "logo.png", mediaType: "image/png", size: 8, key: `artwork/${order.instance}/${fileId}`, at: new Date().toISOString() });
      const model = scriptedModel([
        msg([toolUse("check_artwork", { fileId, reason: "host uploaded a logo" })], "tool_use"),
        msg([], "end_turn"),
      ]);
      agent.modelOverride = model;
      await agent.processTurn();
      expect(agent.sql<{ file_id: string }>`SELECT file_id FROM previews`.map((r) => r.file_id)).toEqual([fileId]);
      expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain(`File ${fileId} (name from the host:`);
    });
  });
});
