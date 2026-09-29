import type {
  BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient } from "./model";

export interface ToolOutcome {
  content: BetaToolResultBlockParam["content"];
  isError?: boolean;
}

export type ToolHandler = (input: unknown) => Promise<ToolOutcome>;

export interface ConversationStore {
  load(): Promise<BetaMessageParam[]>;
  append(message: BetaMessageParam): Promise<void>;
}

export type TurnStatus = "waiting" | "refused" | "tool_limit" | "truncated";

export interface TurnResult {
  status: TurnStatus;
  toolCalls: number;
  modelCalls: number;
}

const LIMIT_TEXT = "Tool call limit reached for this turn. Stop now; you will be woken by the next event.";

export async function runTurn(args: {
  model: ModelClient;
  system: string;
  tools: BetaTool[];
  handlers: Record<string, ToolHandler>;
  store: ConversationStore;
  maxToolCalls: number;
}): Promise<TurnResult> {
  let toolCalls = 0;
  let modelCalls = 0;
  const maxModelCalls = args.maxToolCalls + 2;

  while (true) {
    if (modelCalls >= maxModelCalls) return { status: "tool_limit", toolCalls, modelCalls };
    const response = await args.model.create({ system: args.system, tools: args.tools, messages: await args.store.load() });
    modelCalls++;
    if (response.content.length > 0) await args.store.append({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") return { status: "refused", toolCalls, modelCalls };
    if (response.stop_reason === "pause_turn") continue;

    const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      return { status: response.stop_reason === "max_tokens" ? "truncated" : "waiting", toolCalls, modelCalls };
    }

    const results: BetaToolResultBlockParam[] = [];
    let limited = false;
    for (const use of uses) {
      if (toolCalls >= args.maxToolCalls) {
        limited = true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: LIMIT_TEXT, is_error: true });
        continue;
      }
      toolCalls++;
      const handler = args.handlers[use.name];
      let outcome: ToolOutcome;
      if (!handler) {
        outcome = { content: `Unknown tool: ${use.name}`, isError: true };
      } else {
        try {
          outcome = await handler(use.input);
        } catch (err) {
          outcome = { content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    await args.store.append({ role: "user", content: results });
    if (limited) return { status: "tool_limit", toolCalls, modelCalls };
  }
}
