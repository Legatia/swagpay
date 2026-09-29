import { z } from "zod";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { NewDecision } from "../db";
import { toBase64 } from "../ids";
import { OrderSpecSchema, missingInfo, specErrors, type OrderSpec } from "../order-spec";
import { checkItem, type Policy } from "../policy";
import type { ToolHandler, ToolOutcome } from "./loop";

export const MAX_IMAGE_PREVIEW_BYTES = 3_500_000;
export const MAX_PDF_PREVIEW_BYTES = 10_000_000;
const PREVIEW_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export interface ArtworkFile {
  fileId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ToolContext {
  policy: Policy;
  getSpec(): Promise<OrderSpec>;
  saveSpec(spec: OrderSpec): Promise<void>;
  postToHost(text: string): Promise<void>;
  loadArtwork(fileId: string): Promise<ArtworkFile | null>;
  logDecision(d: Omit<NewDecision, "orderId">): Promise<void>;
}

const reason = z.string().trim().min(3).max(500).describe("One sentence on why, for the public decision log");

const AskHostInput = z.object({ message: z.string().trim().min(1).max(2000).describe("What the host will read"), reason });
const UpdateOrderInput = z.object({ spec: OrderSpecSchema.describe("The whole order as it now stands"), reason });
const CheckArtworkInput = z.object({ fileId: z.string().min(1).max(64), reason });

function inputSchema(schema: z.ZodType): BetaTool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json as BetaTool.InputSchema;
}

export const TOOL_DEFINITIONS: BetaTool[] = [
  {
    name: "ask_host",
    description: "Send a message to the host. This is the only way the host sees anything you write.",
    input_schema: inputSchema(AskHostInput),
  },
  {
    name: "update_order",
    description: "Replace the structured order with the given spec. Returns what is still missing, or why the spec was rejected.",
    input_schema: inputSchema(UpdateOrderInput),
  },
  {
    name: "check_artwork",
    description: "Look at an uploaded artwork file by its fileId. Record your review afterwards with update_order.",
    input_schema: inputSchema(CheckArtworkInput),
  },
];

type Logged = {
  verdict: NewDecision["verdict"];
  outcome: NewDecision["outcome"];
  detail?: string;
  result: ToolOutcome;
};

function logged<S extends z.ZodType>(
  ctx: ToolContext,
  name: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Logged>,
): ToolHandler {
  return async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const r = (raw as { reason?: unknown } | null)?.reason;
      const issue = parsed.error.issues[0];
      const detail = `${issue.path.join(".") || "input"}: ${issue.message}`;
      await ctx.logDecision({ tool: name, reason: typeof r === "string" && r.trim() ? r : "(no reason given)", input: raw, verdict: "none", outcome: "error", detail });
      return { content: `Invalid input. ${detail}`, isError: true };
    }
    try {
      const out = await run(parsed.data);
      await ctx.logDecision({
        tool: name,
        reason: (parsed.data as { reason: string }).reason,
        input: raw,
        verdict: out.verdict,
        outcome: out.outcome,
        ...(out.detail ? { detail: out.detail } : {}),
      });
      return out.result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.logDecision({
        tool: name,
        reason: (parsed.data as { reason: string }).reason,
        input: raw,
        verdict: "none",
        outcome: "error",
        detail: errMsg,
      });
      return { content: `Tool failed: ${errMsg}`, isError: true };
    }
  };
}

export function makeHandlers(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    ask_host: logged(ctx, "ask_host", AskHostInput, async ({ message }) => {
      await ctx.postToHost(message);
      return { verdict: "none", outcome: "done", result: { content: "Sent to the host." } };
    }),

    update_order: logged(ctx, "update_order", UpdateOrderInput, async ({ spec }) => {
      const problems = specErrors(spec);
      const verdicts = spec.items.map((item) => checkItem(item, ctx.policy));
      for (const v of verdicts) if (v.kind === "block") problems.push(v.reason);
      for (const review of spec.artwork) {
        if (!(await ctx.loadArtwork(review.fileId))) problems.push(`no uploaded file has fileId "${review.fileId}"`);
      }
      if (problems.length) {
        const detail = problems.join("; ");
        return { verdict: "block", outcome: "blocked", detail, result: { content: `Not saved. ${detail}`, isError: true } };
      }
      await ctx.saveSpec(spec);
      const approvals = verdicts.filter((v): v is { kind: "escalate"; reason: string } => v.kind === "escalate").map((v) => v.reason);
      const missing = missingInfo(spec);
      const lines = ["Saved."];
      if (approvals.length) lines.push(`This needs the owner's approval: ${approvals.join("; ")}. Tell the host a person will confirm it.`);
      lines.push(missing.length ? `Still missing: ${missing.join("; ")}` : "The order is complete.");
      return approvals.length
        ? { verdict: "escalate", outcome: "escalated", detail: approvals.join("; "), result: { content: lines.join(" ") } }
        : { verdict: "allow", outcome: "done", result: { content: lines.join(" ") } };
    }),

    check_artwork: logged(ctx, "check_artwork", CheckArtworkInput, async ({ fileId }) => {
      const file = await ctx.loadArtwork(fileId);
      if (!file) {
        return { verdict: "none", outcome: "error", detail: "unknown fileId", result: { content: `No uploaded file has fileId "${fileId}".`, isError: true } };
      }
      const head = `${file.name} (${file.mediaType}, ${file.bytes.length} bytes).`;
      const done = (content: ToolOutcome["content"]): Logged => ({ verdict: "none", outcome: "done", result: { content } });
      if ((PREVIEW_IMAGE_TYPES as readonly string[]).includes(file.mediaType)) {
        if (file.bytes.length > MAX_IMAGE_PREVIEW_BYTES) {
          return done(`${head} This image is too large to preview. Ask the host for a PNG under 3.5 MB, or a PDF.`);
        }
        return done([
          { type: "text", text: `${head} Review it, then record the result with update_order.` },
          { type: "image", source: { type: "base64", media_type: file.mediaType as (typeof PREVIEW_IMAGE_TYPES)[number], data: toBase64(file.bytes) } },
        ]);
      }
      if (file.mediaType === "application/pdf") {
        if (file.bytes.length > MAX_PDF_PREVIEW_BYTES) return done(`${head} This PDF is too large to preview. Ask the host for one under 10 MB.`);
        return done([
          { type: "text", text: `${head} Review it, then record the result with update_order.` },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(file.bytes) } },
        ]);
      }
      return done(`${head} I can't preview ${file.mediaType}. Ask the host to export it as a PDF or a PNG with a transparent background.`);
    }),
  };
}
