import { z } from "zod";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { NewDecision } from "../db";
import { toBase64 } from "../ids";
import { OrderSpecSchema, missingInfo, specErrors, type OrderSpec } from "../order-spec";
import { checkItem, type Policy } from "../policy";
import { countPdfPages, sniffMediaType } from "../sniff";
import { sanitize } from "./inbox";
import type { ToolHandler, ToolOutcome } from "./loop";

export const MAX_IMAGE_PREVIEW_BYTES = 3_500_000;
export const MAX_PDF_PREVIEW_BYTES = 5_000_000;
export const MAX_PDF_PREVIEW_PAGES = 10;
/** Cumulative raw bytes of artwork embedded in the conversation per order (it is re-sent on every model call). */
export const MAX_PREVIEW_BYTES_PER_ORDER = 8_000_000;
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
  hasArtwork(fileId: string): Promise<boolean>;
  previewedBytes(): Promise<number>;
  wasPreviewed(fileId: string): Promise<boolean>;
  logDecision(d: Omit<NewDecision, "orderId">): Promise<void>;
  escalateOnce(key: string, kind: "approval" | "agent", summary: string, payload: unknown): Promise<{ id: number; status: "open" | "approved" | "rejected"; created: boolean }>;
}

const reason = z.string().trim().min(3).max(500).describe("One sentence on why, for the public decision log");

const AskHostInput = z.object({ message: z.string().trim().min(1).max(2000).describe("What the host will read"), reason });
const UpdateOrderInput = z.object({ spec: OrderSpecSchema.describe("The whole order as it now stands"), reason });
const CheckArtworkInput = z.object({ fileId: z.string().min(1).max(64), reason });
const EscalateInput = z.object({ summary: z.string().trim().min(3).max(500).describe("What the owner needs to decide or know"), reason });

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
  {
    name: "escalate",
    description: "Ask the owner to decide something you may not decide yourself, or tell them about a problem you can't solve. Their decision arrives later as an event.",
    input_schema: inputSchema(EscalateInput),
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
  // makeHandlers runs once per turn, so this is the turn scope: previews embedded but not yet saved.
  const embeddedThisTurn = new Map<string, number>();
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
        if (!(await ctx.hasArtwork(review.fileId))) problems.push(`no uploaded file has fileId "${review.fileId}"`);
      }
      if (problems.length) {
        const detail = problems.join("; ");
        return { verdict: "block", outcome: "blocked", detail, result: { content: `Not saved. ${detail}`, isError: true } };
      }
      await ctx.saveSpec(spec);
      const reasons = [...new Set(verdicts.filter((v): v is { kind: "escalate"; reason: string } => v.kind === "escalate").map((v) => v.reason))];
      const lines = ["Saved."];
      let waiting = false;
      for (const r of reasons) {
        const e = await ctx.escalateOnce(`approval:${r}`, "approval", `Approve: ${r}`, { reason: r });
        if (e.status === "approved") {
          lines.push(`Approved by the owner (#${e.id}): ${r}.`);
        } else if (e.status === "rejected") {
          waiting = true;
          lines.push(`Rejected by the owner (#${e.id}): ${r}. Remove it from the order and tell the host.`);
        } else {
          waiting = true;
          lines.push(`${e.created ? "Sent to the owner" : "Waiting for the owner"} (#${e.id}): ${r}. Tell the host a person will confirm it.`);
        }
      }
      const missing = missingInfo(spec);
      lines.push(missing.length ? `Still missing: ${missing.join("; ")}` : "The order is complete.");
      return waiting
        ? { verdict: "escalate", outcome: "escalated", detail: reasons.join("; "), result: { content: lines.join(" ") } }
        : { verdict: "allow", outcome: "done", result: { content: lines.join(" ") } };
    }),

    escalate: logged(ctx, "escalate", EscalateInput, async ({ summary }) => {
      const e = await ctx.escalateOnce(`agent:${summary}`, "agent", summary, {});
      return {
        verdict: "escalate",
        outcome: "escalated",
        detail: `#${e.id}`,
        result: { content: e.created ? `Sent to the owner as #${e.id}. Their decision will arrive as an event.` : `Already with the owner as #${e.id} (${e.status}).` },
      };
    }),

    check_artwork: logged(ctx, "check_artwork", CheckArtworkInput, async ({ fileId }) => {
      const file = await ctx.loadArtwork(fileId);
      if (!file) {
        return { verdict: "none", outcome: "error", detail: "unknown fileId", result: { content: `No uploaded file has fileId "${fileId}".`, isError: true } };
      }
      const head = `File ${fileId} (name from the host: ${JSON.stringify(sanitize(file.name))}), ${file.mediaType}, ${file.bytes.length} bytes.`;
      const done = (content: ToolOutcome["content"]): Logged => ({ verdict: "none", outcome: "done", result: { content } });
      const actual = sniffMediaType(file.bytes);
      if (actual !== file.mediaType) {
        return done(`${head} The file's content doesn't match its type (it looks like ${actual ?? "an unknown format"}). Ask the host to export it again as a PNG or PDF.`);
      }
      const isImage = (PREVIEW_IMAGE_TYPES as readonly string[]).includes(file.mediaType);
      const isPdf = file.mediaType === "application/pdf";
      if (!isImage && !isPdf) {
        return done(`${head} I can't preview ${file.mediaType}. Ask the host to export it as a PDF or a PNG with a transparent background.`);
      }
      const limit = isImage ? MAX_IMAGE_PREVIEW_BYTES : MAX_PDF_PREVIEW_BYTES;
      if (file.bytes.length > limit) {
        return done(isImage
          ? `${head} This image is too large to preview. Ask the host for a PNG under 3.5 MB, or a PDF.`
          : `${head} This PDF is too large to preview. Ask the host for one under 5 MB.`);
      }
      if (isPdf) {
        const pages = countPdfPages(file.bytes);
        if (pages !== null && pages > MAX_PDF_PREVIEW_PAGES) {
          return done(`${head} This PDF has ${pages} pages. Ask the host for just the artwork, as a one-page PDF or a PNG.`);
        }
      }
      if (embeddedThisTurn.has(fileId) || (await ctx.wasPreviewed(fileId))) {
        return done(`${head} Its preview is already earlier in this conversation; use that review. If you can't find it there, ask the host to upload the file again.`);
      }
      let used = await ctx.previewedBytes();
      for (const [id, bytes] of embeddedThisTurn) if (!(await ctx.wasPreviewed(id))) used += bytes;
      if (used + file.bytes.length > MAX_PREVIEW_BYTES_PER_ORDER) {
        return done(`${head} This order's preview allowance is used up. Ask the host for a smaller PNG (under 3.5 MB) or PDF (under 5 MB) if you still need to see it.`);
      }
      embeddedThisTurn.set(fileId, file.bytes.length);
      const text = { type: "text" as const, text: `${head} Review it, then record the result with update_order.` };
      return done(isImage
        ? [text, { type: "image", source: { type: "base64", media_type: file.mediaType as (typeof PREVIEW_IMAGE_TYPES)[number], data: toBase64(file.bytes) } }]
        : [text, { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(file.bytes) } }]);
    }),
  };
}
