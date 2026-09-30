import { z } from "zod";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { NewDecision } from "../db";
import { toBase64 } from "../ids";
import { OrderSpecSchema, itemsKey, missingInfo, specErrors, type OrderSpec } from "../order-spec";
import type { Rates } from "../fx";
import { formatCents, type Currency } from "../money";
import { checkItem, checkLeadTime, checkQuote, depositFor, type Policy, type PrintMethod, type Verdict } from "../policy";
import { businessDaysBetween, leadTimeCutoff } from "../time";
import type { NewQuote, QuoteRow } from "../quotes";
import { countPdfPages, imageSize, sniffMediaType } from "../sniff";
import { costRequestText, priceBand, quoteText } from "../quote-text";
import { sanitize } from "./inbox";
import type { ToolHandler, ToolOutcome } from "./loop";

export const MAX_IMAGE_PREVIEW_BYTES = 3_500_000;
export const MAX_PDF_PREVIEW_BYTES = 5_000_000;
export const MAX_PDF_PREVIEW_PAGES = 10;
/** The Claude API refuses images larger than this on either side. */
export const MAX_IMAGE_SIDE = 8000;
/** Cumulative raw bytes of artwork embedded in the conversation per order (it is re-sent on every model call). */
export const MAX_PREVIEW_BYTES_PER_ORDER = 8_000_000;
const PREVIEW_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export interface ArtworkFile {
  fileId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface DecisionLogger {
  logDecision(d: Omit<NewDecision, "orderId">): Promise<void>;
}

export interface ToolContext extends DecisionLogger {
  policy: Policy;
  getSpec(): Promise<OrderSpec>;
  saveSpec(spec: OrderSpec): Promise<void>;
  /** Withdraws the order's open quote when it priced other items; returns its number, or null. */
  withdrawStaleQuote(itemsKey: string): Promise<number | null>;
  postToHost(text: string): Promise<void>;
  loadArtwork(fileId: string): Promise<ArtworkFile | null>;
  hasArtwork(fileId: string): Promise<boolean>;
  previewedBytes(): Promise<number>;
  wasPreviewed(fileId: string): Promise<boolean>;
  /** Up to 3 printer lines for the delivery city; null when the city cannot be read from the delivery place. */
  suggestPrinters(): Promise<string[] | null>;
  orderSummary(): Promise<{ number: number; status: string; deliverBy: Date; deliveryPlace: string }>;
  /** PLN gross (delivery included) the owner gave for these items, or null. */
  printerCost(specKey: string): Promise<number | null>;
  escalateOnce(key: string, kind: "approval" | "agent" | "cost", summary: string, payload: unknown): Promise<{ id: number; status: "open" | "approved" | "rejected"; created: boolean }>;
  rates(currency: Currency): Promise<Rates | null>;
  issueQuote(q: NewQuote, validUntil: Date): Promise<QuoteRow>;
  now(): Date;
}

const reason = z.string().trim().min(3).max(500).describe("One sentence on why, for the public decision log");

const AskHostInput = z.object({ message: z.string().trim().min(1).max(2000).describe("What the host will read"), reason });
const UpdateOrderInput = z.object({ spec: OrderSpecSchema.describe("The whole order as it now stands"), reason });
const CheckArtworkInput = z.object({ fileId: z.string().min(1).max(64), reason });
const EscalateInput = z.object({ summary: z.string().trim().min(3).max(500).describe("What the owner needs to decide or know"), reason });
const RequestCostInput = z.object({ note: z.string().trim().max(500).optional().describe("Anything the printer needs to know, e.g. ink colours"), reason });

const SendQuoteInput = z.object({
  currency: z.enum(["USD", "EUR"]).describe("USD (paid in USDC) or EUR (paid in EURC); follow the host's preference, USD if none"),
  price: z.number().positive().max(100_000).describe("Total for the whole order in that currency, delivery included"),
  message: z.string().trim().min(1).max(2000).describe("What the host reads above the quote: what the price covers, with no amounts, percentages or dates; Swagpay adds those."),
  reason,
});
export function inputSchema(schema: z.ZodType): BetaTool.InputSchema {
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
  {
    name: "request_printer_cost",
    description: "Ask the owner for the printer's cost of the complete order. The cost arrives later as an event.",
    input_schema: inputSchema(RequestCostInput),
  },
  {
    name: "send_quote",
    description: "Send the host a price for the whole order. Checked against the owner's markup band, per-order cap and lead times; the deposit is computed for you.",
    input_schema: inputSchema(SendQuoteInput),
  },
];

export type Logged = {
  verdict: NewDecision["verdict"];
  outcome: NewDecision["outcome"];
  detail?: string;
  result: ToolOutcome;
};

export function logged<S extends z.ZodType>(
  ctx: DecisionLogger,
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

export interface ItemApproval {
  r: string;
  e: { id: number; status: "open" | "approved" | "rejected"; created: boolean };
}

/**
 * Asks the owner about items off the policy list, once per version of those items.
 * The key is the reason plus quantity and description as shown to the owner, so a changed item is asked again
 * and filling in details the owner doesn't see (such as the print method) is not.
 */
async function itemApprovals(ctx: ToolContext, spec: OrderSpec, verdicts: Verdict[]): Promise<ItemApproval[]> {
  const reasons = [...new Set(verdicts.filter((v): v is { kind: "escalate"; reason: string } => v.kind === "escalate").map((v) => v.reason))];
  const out: ItemApproval[] = [];
  for (const r of reasons) {
    const items = spec.items.filter((_, i) => verdicts[i].kind === "escalate" && (verdicts[i] as { reason: string }).reason === r);
    const detail = items.map((it) => `${it.quantity} × ${it.description.replace(/\s+/g, " ")}`).join("; ");
    out.push({ r, e: await ctx.escalateOnce(`approval:${r} [${detail}]`, "approval", `Approve: ${r} (${detail})`, { reason: r, items }) });
  }
  return out;
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
      const order = await ctx.orderSummary();
      if (order.status !== "draft" && order.status !== "quoted") {
        const detail = "a quote was already accepted; send item changes to the owner with escalate";
        return { verdict: "block", outcome: "blocked", detail, result: { content: `Not saved. ${detail}`, isError: true } };
      }
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
      // Ask the owner before saving: approvals are keyed on the items exactly as the owner saw them.
      const decided = await itemApprovals(ctx, spec, verdicts);
      const rejected = decided.filter((d) => d.e.status === "rejected");
      if (rejected.length) {
        const detail = rejected.map((d) => `the owner rejected ${d.r} (#${d.e.id})`).join("; ");
        return { verdict: "block", outcome: "blocked", detail, result: { content: `Not saved: ${detail}. Remove it from the order and tell the host.`, isError: true } };
      }
      await ctx.saveSpec(spec);
      const withdrawn = await ctx.withdrawStaleQuote(await itemsKey(spec));
      const lines = ["Saved."];
      if (withdrawn !== null) {
        lines.push(`Quote #${withdrawn} was withdrawn because the items changed; tell the host a new price will follow, and call request_printer_cost for the new items.`);
      }
      let waiting = false;
      for (const { r, e } of decided) {
        if (e.status === "approved") lines.push(`Approved by the owner (#${e.id}): ${r}.`);
        else {
          waiting = true;
          lines.push(`${e.created ? "Sent to the owner" : "Waiting for the owner"} (#${e.id}): ${r}. Tell the host a person will confirm it.`);
        }
      }
      const missing = missingInfo(spec);
      lines.push(missing.length ? `Still missing: ${missing.join("; ")}` : waiting ? "Everything else is complete; the order waits for the owner's decision." : "The order is complete.");
      return waiting
        ? { verdict: "escalate", outcome: "escalated", detail: decided.map((d) => d.r).join("; "), result: { content: lines.join(" ") } }
        : { verdict: "allow", outcome: "done", result: { content: lines.join(" ") } };
    }),

    request_printer_cost: logged(ctx, "request_printer_cost", RequestCostInput, async ({ note }) => {
      const spec = await ctx.getSpec();
      const missing = missingInfo(spec);
      if (missing.length) {
        const detail = `the order is not complete: ${missing.join("; ")}`;
        return { verdict: "block", outcome: "blocked", detail, result: { content: `Not asked. ${detail}`, isError: true } };
      }
      const key = await itemsKey(spec);
      const known = await ctx.printerCost(key);
      if (known !== null) {
        return { verdict: "none", outcome: "done", result: { content: `The owner already gave the printer cost for this order: ${known.toFixed(2)} PLN gross, delivery included. Use send_quote.` } };
      }
      const order = await ctx.orderSummary();
      const e = await ctx.escalateOnce(`cost:${key}`, "cost", costRequestText(order.number, spec, order.deliverBy, order.deliveryPlace, note, await ctx.suggestPrinters()), { specKey: key });
      const content = e.status === "rejected"
        ? `The owner declined to price this order (#${e.id}). Tell the host a person will contact them.`
        : e.created
          ? `Asked the owner for the printer cost (#${e.id}). It arrives as an event; tell the host you are getting the price.`
          : `Still waiting for the owner's printer cost (#${e.id}).`;
      return { verdict: "escalate", outcome: "escalated", detail: `#${e.id}`, result: { content } };
    }),

    send_quote: logged(ctx, "send_quote", SendQuoteInput, async ({ currency, price, message }) => {
      const blocked = (detail: string): Logged => ({ verdict: "block", outcome: "blocked", detail, result: { content: `Not sent. ${detail}`, isError: true } });
      const order = await ctx.orderSummary();
      if (order.status !== "draft" && order.status !== "quoted") return blocked("a quote was already accepted; changes now go to the owner with escalate");
      const spec = await ctx.getSpec();
      const missing = missingInfo(spec);
      if (missing.length) return blocked(`the order is not complete: ${missing.join("; ")}`);
      // Off-list items need the owner's approval for the items exactly as they stand (plan 2's itemApprovals).
      const itemVerdicts = spec.items.map((item) => checkItem(item, ctx.policy));
      const itemBlock = itemVerdicts.find((v): v is { kind: "block"; reason: string } => v.kind === "block");
      if (itemBlock) return blocked(itemBlock.reason);
      const approvals = await itemApprovals(ctx, spec, itemVerdicts);
      const rejectedItem = approvals.find((a) => a.e.status === "rejected");
      if (rejectedItem) return blocked(`the owner rejected ${rejectedItem.r} (#${rejectedItem.e.id}); remove it from the order and tell the host`);
      const openItems = approvals.filter((a) => a.e.status === "open");
      if (openItems.length) {
        const list = openItems.map((a) => `${a.r} (#${a.e.id})`).join("; ");
        return {
          verdict: "escalate", outcome: "escalated", detail: list,
          result: { content: `Not sent yet: waiting for the owner's approval of ${list}. Tell the host a person is checking.` },
        };
      }
      const key = await itemsKey(spec);
      const costPln = await ctx.printerCost(key);
      if (costPln === null) return blocked("there is no printer cost for the order as it stands; call request_printer_cost");
      const rates = await ctx.rates(currency);
      if (!rates) return blocked("exchange rates are unavailable right now; try again later");
      const priceCents = Math.round(price * 100);
      const q = { price: priceCents / 100, currency, costPln, plnPerUnit: rates.plnPerUnit, usdPerUnit: rates.usdPerUnit };
      const { verdict, markup } = checkQuote(q, ctx.policy);
      if (verdict.kind === "block") {
        const { lo, hi } = priceBand(costPln, rates.plnPerUnit, ctx.policy);
        return blocked(`${verdict.reason}; price it between ${lo.toFixed(2)} and ${hi.toFixed(2)} ${currency}`);
      }
      const now = ctx.now();
      if (order.deliverBy.getTime() <= now.getTime()) return blocked("the delivery deadline has passed; ask the host for a new date and escalate");
      const verdicts: Verdict[] = [verdict];
      const strictest = Math.max(...Object.values(ctx.policy.minLeadBusinessDays));
      // The lead time the whole order needs: each listed item's method, the strictest standard for off-list items.
      const required = Math.max(...spec.items.map((item) => {
        const min = Object.hasOwn(ctx.policy.allowedItems, item.kind) ? ctx.policy.minLeadBusinessDays[item.method as PrintMethod] : undefined;
        return min ?? strictest;
      }));
      for (const item of spec.items) {
        if (Object.hasOwn(ctx.policy.allowedItems, item.kind)) {
          verdicts.push(checkLeadTime(now, order.deliverBy, item.method as PrintMethod, ctx.policy));
        } else {
          // Owner-approved off-list items have no lead-time rule of their own: hold them to the strictest standard one.
          const days = businessDaysBetween(now, order.deliverBy);
          if (days < strictest) verdicts.push({ kind: "escalate", reason: `only ${days} business days before the deadline for ${item.kind}; standard jobs need up to ${strictest}` });
        }
      }
      const block = verdicts.find((v): v is { kind: "block"; reason: string } => v.kind === "block");
      if (block) return blocked(block.reason);
      const reasons = [...new Set(verdicts.filter((v): v is { kind: "escalate"; reason: string } => v.kind === "escalate").map((v) => v.reason))];
      const waiting: string[] = [];
      for (const r of reasons) {
        const e = await ctx.escalateOnce(`approval:${r}`, "approval", `Approve: ${r}`, { reason: r });
        if (e.status === "rejected") return blocked(`the owner rejected: ${r} (#${e.id})`);
        if (e.status === "open") waiting.push(`${e.created ? "Sent to the owner" : "Waiting for the owner"} (#${e.id}): ${r}`);
      }
      if (waiting.length) {
        return {
          verdict: "escalate", outcome: "escalated", detail: reasons.join("; "),
          result: { content: `Not sent yet. ${waiting.join(". ")}. Tell the host a person is checking, then wait for the decision event.` },
        };
      }
      const depositCents = Math.round(depositFor(q, ctx.policy) * 100);
      // Valid while the lead time still fits; a quote approved with the deadline already close lasts until tonight's midnight.
      const validUntil = new Date(Math.min(
        now.getTime() + ctx.policy.quoteValidityHours * 3_600_000,
        leadTimeCutoff(now, order.deliverBy, required).getTime(),
        order.deliverBy.getTime(),
      ));
      const quote = await ctx.issueQuote({ currency, priceCents, depositCents, costPln, plnPerUnit: rates.plnPerUnit, usdPerUnit: rates.usdPerUnit, markup, itemsKey: key }, validUntil);
      await ctx.postToHost(`${message}\n\n${quoteText(quote)}`);
      return {
        verdict: "allow", outcome: "done", detail: `quote #${quote.id}`,
        result: { content: `Quote #${quote.id} sent: ${formatCents(priceCents)} ${currency}, deposit ${formatCents(depositCents)} ${currency}.` },
      };
    }),

    escalate: logged(ctx, "escalate", EscalateInput, async ({ summary: raw }) => {
      const summary = raw.replace(/\s+/g, " ");
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
      // One file the API refuses would break every later model call of the order, so embed only what is known to fit.
      if (isPdf) {
        const pages = countPdfPages(file.bytes);
        if (pages === null) {
          return done(`${head} I can't tell how many pages this PDF has, so I won't preview it. Ask the host to export the artwork as a PNG (under 3.5 MB).`);
        }
        if (pages > MAX_PDF_PREVIEW_PAGES) {
          return done(`${head} This PDF has ${pages} pages. Ask the host for just the artwork, as a one-page PDF or a PNG.`);
        }
      } else {
        const size = imageSize(file.bytes, file.mediaType);
        if (!size) {
          return done(`${head} I can't read this image's size; it may be damaged. Ask the host to export it again as a PNG.`);
        }
        if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) {
          return done(`${head} This image is ${size.width}×${size.height} pixels; I can preview up to ${MAX_IMAGE_SIDE} pixels per side. Ask the host for a smaller PNG export.`);
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
