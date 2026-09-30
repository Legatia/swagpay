import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createGeminiModel } from "./gemini";

export interface ModelRequest {
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
}

export interface ModelClient {
  create(req: ModelRequest): Promise<BetaMessage>;
}

export interface ModelEnv {
  MODEL_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  MODEL: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

/** The model the agents run on: MODEL_PROVIDER "gemini" or "anthropic" (the default). */
export function createModel(env: ModelEnv): ModelClient {
  const provider = (env.MODEL_PROVIDER || "anthropic").trim().toLowerCase();
  if (provider === "gemini") return createGeminiModel(env);
  if (provider === "anthropic") return createAnthropicModel(env);
  throw new Error(`MODEL_PROVIDER must be "gemini" or "anthropic", got "${env.MODEL_PROVIDER}"`);
}

/**
 * Drops Gemini's thought signatures, which only Gemini reads, and the empty text blocks that only carried one,
 * so a conversation can move between providers.
 */
export function withoutProviderFields(messages: BetaMessageParam[]): BetaMessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const content = m.content
      .filter((b) => !(b.type === "text" && b.text === ""))
      .map((b) => ("gemini_signature" in b ? (({ gemini_signature: _, ...rest }) => rest)(b as typeof b & { gemini_signature?: string }) : b));
    return { ...m, content: content as typeof m.content };
  });
}

/**
 * Claude via the beta Messages API. Server-side refusal fallback is on ("default"),
 * the stable system prompt is cached, and effort is "medium" for multistep tool use.
 */
export function createAnthropicModel(env: { ANTHROPIC_API_KEY?: string; MODEL: string }): ModelClient {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3 });
  return {
    create: (req) =>
      client.beta.messages.create({
        model: env.MODEL,
        max_tokens: 16000,
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: withoutProviderFields(req.messages),
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }),
  };
}
