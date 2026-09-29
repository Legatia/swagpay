import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient, ModelRequest } from "../src/agent/model";
import type { ConversationStore } from "../src/agent/loop";

export function msg(content: unknown[], stop_reason: string): BetaMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

export function toolUse(name: string, input: unknown, id = `tu_${crypto.randomUUID()}`) {
  return { type: "tool_use", id, name, input };
}

export function scriptedModel(responses: BetaMessage[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async create(req) {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (!next) throw new Error("scripted model ran out of responses");
      return next;
    },
  };
}

export function memoryStore(initial: BetaMessageParam[] = []): ConversationStore & { messages: BetaMessageParam[] } {
  const messages = [...initial];
  return {
    messages,
    async load() { return structuredClone(messages); },
    async append(m) { messages.push(structuredClone(m)); },
  };
}
