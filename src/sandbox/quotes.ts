// Sandbox: the printers the agent asked reply with simulated quotes. Each reply's delay and whether it declines are a fixed hash of
// (order, printer); offers come from simulatedQuote. The agent hears once, when every asked printer has answered or expired.
import { getOrderById } from "../db";
import { plnPer } from "../fx";
import { addOffer } from "../offers";
import type { OrderSpec } from "../order-spec";
import { MAX_ASKED_PER_COST_REQUEST, type QuoteRequestRow } from "../quote-requests";
import { isPolishBusinessDay, warsawDate } from "../time";
import { getVendor, type VendorRow } from "../vendors";
import { SIMULATED, simulatedQuote } from "./printer";

export const REPLY_EXPIRY_SECONDS = 600;
const DEFAULT_LEAD_DAYS = 5;
const REASONS = ["fully booked until after your date", "can't take a job this size right now"];

/** 32-bit FNV-1a. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** How a printer answers this order: after 60–180 seconds, declining about one time in four. */
export function replyPlan(orderId: number, vendorId: number): { delaySeconds: number; declines: boolean; reason: string } {
  const h = fnv1a(`swagpay-quote:${orderId}:${vendorId}`);
  return { delaySeconds: 60 + (h % 121), declines: ((h >>> 8) & 3) === 0, reason: REASONS[(h >>> 16) & 1] };
}

/** The offer's arrival: N Polish working days after today in Warsaw, N being the printer's longest numeric lead time for the order's methods, else 5. */
export function arrivalDate(now: Date, vendor: Pick<VendorRow, "lead_days"> | null, methods: string[]): string {
  let days = DEFAULT_LEAD_DAYS;
  try {
    const lead = JSON.parse(vendor?.lead_days ?? "null") as Record<string, unknown> | null;
    const nums = methods.map((m) => lead?.[m]).filter((v): v is number => typeof v === "number" && v > 0 && v < 60);
    if (nums.length) days = Math.max(...nums);
  } catch { /* free-text lead times: the default */ }
  let t = Date.parse(`${warsawDate(now)}T12:00:00Z`);
  for (let n = 0; n < days; ) {
    t += 86_400_000;
    if (isPolishBusinessDay(new Date(t).toISOString().slice(0, 10))) n++;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Settles one asked printer: a decline, or an offer (simulatedQuote, delivery included). Null when there was nothing to settle. */
export async function replyToQuoteRequest(env: Env, id: number, now: Date = new Date()): Promise<{ escalationId: number } | null> {
  const row = await env.DB.prepare("SELECT * FROM quote_requests WHERE id = ?").bind(id).first<QuoteRequestRow>();
  if (!row || row.status !== "asked") return null;
  const order = await getOrderById(env.DB, row.order_id);
  const vendor = await getVendor(env.DB, row.vendor_id);
  let spec: OrderSpec | null = null;
  try {
    spec = order?.spec_json ? (JSON.parse(order.spec_json) as OrderSpec) : null;
  } catch {
    spec = null;
  }
  const plan = replyPlan(row.order_id, row.vendor_id);
  const quote = order && !plan.declines ? simulatedQuote(order, spec, vendor) : null;
  const at = now.toISOString();
  if (!quote) {
    const reason = plan.declines ? plan.reason : "couldn't price this order";
    const r = await env.DB.prepare("UPDATE quote_requests SET status = 'declined', decline_reason = ?, settled_at = ? WHERE id = ? AND status = 'asked'").bind(reason, at, id).run();
    return r.meta.changes === 1 ? { escalationId: row.escalation_id } : null;
  }
  // Claim the row first, so a reply racing the expiry (or a repeat) settles it once.
  const claimed = await env.DB.prepare("UPDATE quote_requests SET status = 'replied', settled_at = ? WHERE id = ? AND status = 'asked'").bind(at, id).run();
  if (claimed.meta.changes !== 1) return null;
  try {
    const methods = [...new Set((spec?.items ?? []).map((i) => i.method).filter((m): m is string => !!m))];
    const offer = await addOffer(env.DB, {
      orderId: row.order_id, vendorId: row.vendor_id, currency: quote.currency, priceCents: Math.round(quote.amount * 100), deliveryCents: 0, otherCents: 0,
      arrivesAt: arrivalDate(now, vendor, methods), note: `quote request #${row.id} (${SIMULATED})`,
    }, now);
    await env.DB.prepare("UPDATE quote_requests SET offer_id = ? WHERE id = ?").bind(offer.id, id).run();
  } catch (err) {
    await env.DB.prepare("UPDATE quote_requests SET status = 'asked', settled_at = NULL WHERE id = ?").bind(id).run();
    throw err;
  }
  return { escalationId: row.escalation_id };
}

/** Marks printers asked at least 10 minutes ago that haven't answered as expired; returns how many. */
export async function expireQuoteRequests(env: Env, escalationId: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - (REPLY_EXPIRY_SECONDS - 5) * 1000).toISOString();
  const r = await env.DB
    .prepare("UPDATE quote_requests SET status = 'expired', settled_at = ? WHERE escalation_id = ? AND status = 'asked' AND created_at <= ?")
    .bind(now.toISOString(), escalationId, cutoff)
    .run();
  return r.meta.changes;
}

type ReplyRow = Pick<QuoteRequestRow, "id" | "vendor_id" | "status" | "offer_id" | "decline_reason" | "notified_at"> & {
  currency: string | null; price_cents: number | null; delivery_cents: number | null; other_cents: number | null; arrives_at: string | null; deliver_by: string;
};

/**
 * The agent's event once no asked printer is still waiting: the replies it hasn't heard yet (offers by number, never by name),
 * and what to do next. Marks them heard; null when there is nothing new.
 */
export async function repliesEvent(env: Env, escalationId: number, now: Date = new Date()): Promise<string | null> {
  const rows = (await env.DB
    .prepare(
      `SELECT qr.id, qr.vendor_id, qr.status, qr.offer_id, qr.decline_reason, qr.notified_at,
              po.currency, po.price_cents, po.delivery_cents, po.other_cents, po.arrives_at, o.deliver_by
       FROM quote_requests qr JOIN orders o ON o.id = qr.order_id LEFT JOIN printer_offers po ON po.id = qr.offer_id
       WHERE qr.escalation_id = ? AND qr.status != 'drafted' ORDER BY qr.id`,
    )
    .bind(escalationId)
    .all<ReplyRow>()).results;
  if (!rows.length || rows.some((r) => r.status === "asked")) return null;
  const fresh = rows.filter((r) => r.notified_at === null);
  if (!fresh.length) return null;
  const heard = await env.DB
    .prepare(`UPDATE quote_requests SET notified_at = ? WHERE notified_at IS NULL AND id IN (${fresh.map(() => "?").join(", ")})`)
    .bind(now.toISOString(), ...fresh.map((r) => r.id))
    .run();
  if (heard.meta.changes === 0) return null; // another callback told the agent first
  const parts: string[] = [];
  for (const r of fresh) {
    if (r.status === "replied" && r.offer_id !== null && r.currency) {
      const total = (r.price_cents ?? 0) + (r.delivery_cents ?? 0) + (r.other_cents ?? 0);
      const rate = await plnPer(env.DB, r.currency, now);
      const landed = rate === null ? `${(total / 100).toFixed(2)} ${r.currency}` : `${((total * rate) / 100).toFixed(2)} PLN landed`;
      const late = (r.arrives_at ?? "") > r.deliver_by.slice(0, 10);
      parts.push(`offer #${r.offer_id} from printer #${r.vendor_id}: ${landed}, arrives ${r.arrives_at} (${late ? "late" : "on time"})`);
    } else if (r.status === "declined") {
      parts.push(`printer #${r.vendor_id} declined: ${r.decline_reason ?? "no reason given"}`);
    } else {
      parts.push(`printer #${r.vendor_id} didn't reply in time`);
    }
  }
  const left = MAX_ASKED_PER_COST_REQUEST - rows.length;
  const next = fresh.some((r) => r.status === "replied")
    ? "The owner chooses one of these offers; tell the host the price is on its way."
    : left > 0
      ? `No offer this time. You may ask up to ${left} other printers: call request_printer_cost with new printerIds (find_printers lists them). Otherwise tell the host a person will follow up.`
      : "No printer made an offer. Tell the host a person will follow up.";
  return `Printer replies for cost request #${escalationId} (simulated): ${parts.join("; ")}. ${next}`;
}
