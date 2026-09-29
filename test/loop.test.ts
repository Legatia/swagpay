import { describe, expect, it } from "vitest";
import { runTurn, type ToolHandler } from "../src/agent/loop";
import { memoryStore, msg, scriptedModel, toolUse } from "./helpers";

const user = { role: "user" as const, content: "<event>New order</event>" };
const echo: ToolHandler = async (input) => ({ content: `ok ${JSON.stringify(input)}` });

describe("runTurn", () => {
  it("runs tools until the model ends its turn, appending everything in order", async () => {
    const model = scriptedModel([
      msg([{ type: "thinking", thinking: "", signature: "sig" }, toolUse("echo", { a: 1 }, "t1")], "tool_use"),
      msg([{ type: "text", text: "waiting" }], "end_turn"),
    ]);
    const store = memoryStore([user]);
    const r = await runTurn({ model, system: "S", tools: [], handlers: { echo }, store, maxToolCalls: 12 });
    expect(r).toEqual({ status: "waiting", toolCalls: 1, modelCalls: 2 });
    expect(store.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(store.messages[1].content).toEqual([{ type: "thinking", thinking: "", signature: "sig" }, toolUse("echo", { a: 1 }, "t1")]);
    expect(store.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: 'ok {"a":1}' }]);
    // the second request replays the first response unchanged
    expect(model.requests[1].messages[1]).toEqual(store.messages[1]);
  });

  it("returns every tool result in one user message for parallel calls", async () => {
    const model = scriptedModel([
      msg([toolUse("echo", { a: 1 }, "t1"), toolUse("echo", { a: 2 }, "t2")], "tool_use"),
      msg([], "end_turn"),
    ]);
    const store = memoryStore([user]);
    await runTurn({ model, system: "S", tools: [], handlers: { echo }, store, maxToolCalls: 12 });
    const results = store.messages[2].content as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(store.messages).toHaveLength(3); // empty final content is not appended
  });

  it("reports unknown tools and thrown handlers as tool errors", async () => {
    const boom: ToolHandler = async () => { throw new Error("kaput"); };
    const model = scriptedModel([
      msg([toolUse("nope", {}, "t1"), toolUse("boom", {}, "t2")], "tool_use"),
      msg([{ type: "text", text: "ok" }], "end_turn"),
    ]);
    const store = memoryStore([user]);
    await runTurn({ model, system: "S", tools: [], handlers: { boom }, store, maxToolCalls: 12 });
    expect(store.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "Unknown tool: nope", is_error: true },
      { type: "tool_result", tool_use_id: "t2", content: "Tool failed: kaput", is_error: true },
    ]);
  });

  it("stops at the tool-call limit and still answers every tool_use", async () => {
    const model = scriptedModel([msg([toolUse("echo", {}, "t1"), toolUse("echo", {}, "t2"), toolUse("echo", {}, "t3")], "tool_use")]);
    const store = memoryStore([user]);
    const r = await runTurn({ model, system: "S", tools: [], handlers: { echo }, store, maxToolCalls: 2 });
    expect(r.status).toBe("tool_limit");
    const results = store.messages[2].content as Array<{ tool_use_id: string; is_error?: boolean }>;
    expect(results.map((x) => [x.tool_use_id, x.is_error ?? false])).toEqual([["t1", false], ["t2", false], ["t3", true]]);
  });

  it("stops on a refusal and continues on pause_turn", async () => {
    const refused = await runTurn({
      model: scriptedModel([msg([], "refusal")]), system: "S", tools: [], handlers: {}, store: memoryStore([user]), maxToolCalls: 12,
    });
    expect(refused.status).toBe("refused");

    const model = scriptedModel([msg([{ type: "text", text: "..." }], "pause_turn"), msg([{ type: "text", text: "done" }], "end_turn")]);
    const r = await runTurn({ model, system: "S", tools: [], handlers: {}, store: memoryStore([user]), maxToolCalls: 12 });
    expect(r).toEqual({ status: "waiting", toolCalls: 0, modelCalls: 2 });
  });
});
