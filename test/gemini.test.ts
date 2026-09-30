import { describe, expect, it } from "vitest";
import type { BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createGeminiModel, fromGeminiResponse, toGeminiRequest } from "../src/agent/gemini";
import { runTurn } from "../src/agent/loop";
import { createModel, withoutProviderFields } from "../src/agent/model";
import { memoryStore } from "./helpers";

const tool: BetaTool = {
  name: "ask_host",
  description: "Send a message to the host.",
  input_schema: { type: "object", properties: { message: { type: "string" }, reason: { type: "string" } }, required: ["message", "reason"], additionalProperties: false },
};

type Json = Record<string, unknown>;
const reply = (parts: Json[], finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

function fakeGemini(replies: Array<Json | { status: number; body?: Json }>) {
  const calls: { url: string; headers: Record<string, string>; body: Json }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = replies.shift();
    if (!next) throw new Error("fake Gemini ran out of replies");
    if ("status" in next && typeof next.status === "number") return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Gemini request translation", () => {
  it("maps the system prompt, tools and a tool round trip, with names, ids and signatures", () => {
    const messages: BetaMessageParam[] = [
      { role: "user", content: [{ type: "text", text: "<event>New order.</event>" }] },
      { role: "assistant", content: [
        { type: "text", text: "Let me ask.", gemini_signature: "sig-text" },
        { type: "tool_use", id: "gemcall_local-1", name: "ask_host", input: { message: "Sizes?", reason: "sizes missing" }, gemini_signature: "sig-call" },
        { type: "tool_use", id: "call-from-gemini", name: "check_artwork", input: { fileId: "f1", reason: "look" } },
      ] as never },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "gemcall_local-1", content: "Sent to the host." },
        { type: "tool_result", tool_use_id: "call-from-gemini", content: [
          { type: "text", text: "logo.png, 800×600" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ] },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "gemcall_2", name: "ask_host", input: {} }] as never },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "gemcall_2", content: "Invalid input.", is_error: true }] },
    ];
    const body = toGeminiRequest({ system: "You are Swagpay's order agent.", tools: [tool], messages });
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are Swagpay's order agent." }] });
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "ask_host", description: "Send a message to the host.", parametersJsonSchema: tool.input_schema }] }]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    const contents = body.contents as { role: string; parts: Json[] }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
    expect(contents[1].parts).toEqual([
      { text: "Let me ask.", thoughtSignature: "sig-text" },
      { functionCall: { name: "ask_host", args: { message: "Sizes?", reason: "sizes missing" } }, thoughtSignature: "sig-call" },
      { functionCall: { name: "check_artwork", args: { fileId: "f1", reason: "look" }, id: "call-from-gemini" } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "ask_host", response: { output: "Sent to the host." } } },
      { functionResponse: { name: "check_artwork", response: { output: "logo.png, 800×600" }, id: "call-from-gemini" } },
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
    ]);
    expect(contents[4].parts).toEqual([{ functionResponse: { name: "ask_host", response: { error: "Invalid input." } } }]);
  });
});

describe("Gemini response translation", () => {
  it("turns function calls into tool_use blocks that keep the signature, and skips thoughts", () => {
    const msg = fromGeminiResponse(reply([
      { text: "thinking…", thought: true },
      { text: "Asking the host." },
      { functionCall: { name: "ask_host", args: { message: "Hi", reason: "greet" } }, thoughtSignature: "sig-1" },
    ]), "gemini-3.8-flash", () => "x");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toEqual([
      { type: "text", text: "Asking the host." },
      { type: "tool_use", id: "gemcall_x", name: "ask_host", input: { message: "Hi", reason: "greet" }, gemini_signature: "sig-1" },
    ]);
    expect(msg.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it("maps finish reasons: stop, max tokens, safety and a blocked prompt", () => {
    expect(fromGeminiResponse(reply([{ text: "Done." }]), "m").stop_reason).toBe("end_turn");
    expect(fromGeminiResponse(reply([{ text: "Half" }], "MAX_TOKENS"), "m").stop_reason).toBe("max_tokens");
    expect(fromGeminiResponse(reply([], "SAFETY"), "m").stop_reason).toBe("refusal");
    const blocked = fromGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }, "m");
    expect(blocked.stop_reason).toBe("refusal");
    expect(blocked.content).toEqual([]);
  });
});

describe("Gemini client", () => {
  it("calls generateContent with the key in a header, and retries a busy server", async () => {
    const { calls, fetchImpl } = fakeGemini([{ status: 503 }, reply([{ text: "Hello." }])]);
    const waits: number[] = [];
    const model = createGeminiModel({ GEMINI_API_KEY: "secret-key", GEMINI_MODEL: "gemini-3.8-flash" }, { fetch: fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const msg = await model.create({ system: "s", tools: [tool], messages: [{ role: "user", content: "hi" }] });
    expect(msg.content).toEqual([{ type: "text", text: "Hello." }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0].headers["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0].url).not.toContain("secret-key");
    expect(waits).toEqual([1000]);
  });

  it("reports API errors without the key, fails clearly without one, and retries a malformed call once", async () => {
    const bad = fakeGemini([{ status: 400, body: { error: { message: "Invalid JSON payload" } } }]);
    const err = await createGeminiModel({ GEMINI_API_KEY: "secret-key" }, { fetch: bad.fetchImpl }).create({ system: "s", tools: [], messages: [{ role: "user", content: "hi" }] }).catch((e: Error) => e);
    expect((err as Error).message).toBe("Gemini 400: Invalid JSON payload");
    expect((err as Error).message).not.toContain("secret-key");
    await expect(createGeminiModel({}).create({ system: "s", tools: [], messages: [] })).rejects.toThrow("GEMINI_API_KEY is not set");
    const slip = fakeGemini([reply([], "MALFORMED_FUNCTION_CALL"), reply([{ text: "Fixed." }])]);
    const fixed = await createGeminiModel({ GEMINI_API_KEY: "k" }, { fetch: slip.fetchImpl }).create({ system: "s", tools: [tool], messages: [{ role: "user", content: "hi" }] });
    expect(fixed.content).toEqual([{ type: "text", text: "Fixed." }]);
  });

  it("runs a whole tool turn in the agent loop and sends the signature back", async () => {
    const { calls, fetchImpl } = fakeGemini([
      reply([{ functionCall: { name: "ask_host", args: { message: "Which sizes?", reason: "sizes missing" } }, thoughtSignature: "sig-A" }]),
      reply([{ text: "" , thoughtSignature: "sig-B" }]),
    ]);
    const store = memoryStore([{ role: "user", content: [{ type: "text", text: "<host_message>60 tees</host_message>" }] }]);
    const asked: unknown[] = [];
    const result = await runTurn({
      model: createGeminiModel({ GEMINI_API_KEY: "k" }, { fetch: fetchImpl }),
      system: "s", tools: [tool], store, maxToolCalls: 4,
      handlers: { ask_host: async (input) => { asked.push(input); return { content: "Sent to the host." }; } },
    });
    expect(result.status).toBe("waiting");
    expect(asked).toEqual([{ message: "Which sizes?", reason: "sizes missing" }]);
    const second = calls[1].body.contents as { role: string; parts: Json[] }[];
    expect(second[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "ask_host", args: { message: "Which sizes?", reason: "sizes missing" } }, thoughtSignature: "sig-A" }] });
    expect(second[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "ask_host", response: { output: "Sent to the host." } } }] });
  });
});

describe("provider switch", () => {
  it("picks Gemini or Claude from MODEL_PROVIDER and refuses anything else", () => {
    expect(() => createModel({ MODEL_PROVIDER: "gemini", MODEL: "x" })).not.toThrow();
    expect(() => createModel({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", MODEL: "x" })).not.toThrow();
    expect(() => createModel({ MODEL_PROVIDER: "openai", MODEL: "x" })).toThrow('MODEL_PROVIDER must be "gemini" or "anthropic"');
  });

  it("strips Gemini signatures before a conversation goes to Claude", () => {
    const out = withoutProviderFields([
      { role: "assistant", content: [{ type: "text", text: "", gemini_signature: "sig-0" }, { type: "tool_use", id: "gemcall_1", name: "ask_host", input: {}, gemini_signature: "sig" }] as never },
      { role: "user", content: "hi" },
    ]);
    expect(out[0].content).toEqual([{ type: "tool_use", id: "gemcall_1", name: "ask_host", input: {} }]);
    expect(out[1].content).toBe("hi");
  });
});
