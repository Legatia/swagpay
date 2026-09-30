import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient, ModelRequest } from "./model";

/**
 * Gemini behind the same ModelClient the agents use: requests and replies are translated to and from the
 * Messages shape the tool loop and the conversation store already speak. Gemini's thought signatures ride on
 * the translated blocks (`gemini_signature`) and go back on the same parts, which multi-step function calling needs.
 */

const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Ids we make up for calls that came without one; they are never sent back to Gemini. */
const LOCAL_ID = "gemcall_";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

type Json = Record<string, unknown>;
type Part = Json;
type GeminiContent = { role: "user" | "model"; parts: Part[] };

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
  gemini_signature?: string;
}

const signed = (part: Part, block: Block): Part => (block.gemini_signature ? { ...part, thoughtSignature: block.gemini_signature } : part);

function mediaPart(block: Block): Part | null {
  const src = block.source;
  if ((block.type === "image" || block.type === "document") && src?.type === "base64" && src.media_type && src.data) {
    return { inlineData: { mimeType: src.media_type, data: src.data } };
  }
  return null;
}

/** The Messages-shaped request as a generateContent body. */
export function toGeminiRequest(req: ModelRequest, opts: { maxOutputTokens?: number } = {}): Json {
  const names = new Map<string, string>();
  const contents: GeminiContent[] = [];
  for (const message of req.messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as unknown as Block[]);
    const parts: Part[] = [];
    const media: Part[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text || block.gemini_signature) parts.push(signed({ text: block.text }, block));
      } else if (block.type === "tool_use" && block.id && block.name) {
        names.set(block.id, block.name);
        const call: Json = { name: block.name, args: block.input ?? {} };
        if (!block.id.startsWith(LOCAL_ID)) call.id = block.id;
        parts.push(signed({ functionCall: call }, block));
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const content = typeof block.content === "string" ? [{ type: "text", text: block.content }] : (block.content ?? []);
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        for (const c of content) {
          const m = mediaPart(c);
          if (m) media.push(m);
        }
        const response: Json = { name: names.get(block.tool_use_id) ?? "unknown_tool", response: block.is_error ? { error: text } : { output: text } };
        if (!block.tool_use_id.startsWith(LOCAL_ID)) response.id = block.tool_use_id;
        parts.push({ functionResponse: response });
      } else {
        const m = mediaPart(block);
        if (m) parts.push(m);
      }
    }
    // Files a tool returned go right after the function responses of the same turn.
    parts.push(...media);
    if (parts.length) contents.push({ role, parts });
  }
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    ...(req.tools.length
      ? {
        tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.input_schema })) }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      }
      : {}),
    generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 16000 },
  };
}

const REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** A generateContent reply as a Messages-shaped message. */
export function fromGeminiResponse(body: Json, model: string, newId: () => string = () => crypto.randomUUID()): BetaMessage {
  const candidate = (body.candidates as Json[] | undefined)?.[0];
  const usage = (body.usageMetadata ?? {}) as Json;
  const content: Block[] = [];
  let stop = "end_turn";
  if (!candidate) {
    // No candidate: the prompt itself was blocked.
    stop = "refusal";
  } else {
    for (const part of ((candidate.content as Json | undefined)?.parts as Part[] | undefined) ?? []) {
      if (part.thought === true) continue;
      const signature = typeof part.thoughtSignature === "string" ? { gemini_signature: part.thoughtSignature } : {};
      const call = part.functionCall as { id?: string; name?: string; args?: unknown } | undefined;
      if (call?.name) {
        content.push({ type: "tool_use", id: call.id || `${LOCAL_ID}${newId()}`, name: call.name, input: call.args ?? {}, ...signature });
      } else if (typeof part.text === "string" && (part.text || signature.gemini_signature)) {
        content.push({ type: "text", text: part.text, ...signature });
      }
    }
    const reason = String(candidate.finishReason ?? "STOP");
    if (content.some((b) => b.type === "tool_use")) stop = "tool_use";
    else if (reason === "MAX_TOKENS") stop = "max_tokens";
    else if (REFUSALS.has(reason)) stop = "refusal";
  }
  return {
    id: `gemini_${String(body.responseId ?? newId())}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.promptTokenCount ?? 0),
      output_tokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
    },
  } as unknown as BetaMessage;
}

export function createGeminiModel(
  env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string },
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): ModelClient {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  return {
    async create(req) {
      if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
      const body = JSON.stringify(toGeminiRequest(req));
      let malformed = 0;
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(`${API}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body,
          signal: AbortSignal.timeout(120_000),
        });
        if (RETRY_STATUSES.has(res.status) && attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const json = (await res.json().catch(() => ({}))) as Json;
        if (!res.ok) {
          const message = String((json.error as Json | undefined)?.message ?? res.statusText ?? "request failed").slice(0, 300);
          throw new Error(`Gemini ${res.status}: ${message}`);
        }
        // A malformed function call is the model's slip, not the request's: ask once more.
        if ((json.candidates as Json[] | undefined)?.[0]?.finishReason === "MALFORMED_FUNCTION_CALL" && malformed++ < 1) continue;
        return fromGeminiResponse(json, model);
      }
    },
  };
}
