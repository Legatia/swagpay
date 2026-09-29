import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export interface ModelRequest {
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
}

export interface ModelClient {
  create(req: ModelRequest): Promise<BetaMessage>;
}

/**
 * Claude via the beta Messages API. Server-side refusal fallback is on ("default"),
 * the stable system prompt is cached, and effort is "medium" for multistep tool use.
 */
export function createAnthropicModel(env: { ANTHROPIC_API_KEY: string; MODEL: string }): ModelClient {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3 });
  return {
    create: (req) =>
      client.beta.messages.create({
        model: env.MODEL,
        max_tokens: 16000,
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }),
  };
}
