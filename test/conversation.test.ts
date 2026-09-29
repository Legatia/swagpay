import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vitest";
import { SqlR2ConversationStore } from "../src/agent/conversation";
import type { OrderAgent } from "../src/agent/order-agent";

it("keeps big base64 out of SQLite and restores it byte for byte", async () => {
  const stub = await getAgentByName(env.OrderAgent, "conv-test");
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    agent.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    const store = new SqlR2ConversationStore(agent.sql.bind(agent), env.ARTWORK, "conv/test/");
    const big = "A".repeat(3_000_000);
    const message = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "t1", content: [
        { type: "text" as const, text: "logo.png" },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: big } },
      ] }],
    };
    await store.append(message);
    const row = agent.sql<{ message: string }>`SELECT message FROM conversation`[0];
    expect(row.message.length).toBeLessThan(10_000);
    expect(await store.load()).toEqual([message]);
  });
});

it("leaves forged r2 markers in model-written tool input alone", async () => {
  const stub = await getAgentByName(env.OrderAgent, "conv-forge");
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    agent.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    const store = new SqlR2ConversationStore(agent.sql.bind(agent), env.ARTWORK, "conv/forge/");
    const message = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "t1", name: "x", input: { type: "base64", data: "r2:conv/other/abc" } }],
    };
    await store.append(message);
    expect(await store.load()).toEqual([message]);
    // even an image block cannot pull a blob outside this order's prefix
    const img = { role: "user" as const, content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "r2:conv/other/abc" } }] };
    await store.append(img);
    expect(await store.load()).toEqual([message, img]);
  });
});
