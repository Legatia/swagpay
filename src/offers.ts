import { plnPer } from "./fx";
import { giveCost } from "./telegram-webhook";
import { vendorJobFor } from "./vendors";

export interface OfferRow {
  id: number; order_id: number; vendor_id: number; currency: string; price_cents: number; delivery_cents: number; other_cents: number;
  arrives_at: string; note: string | null; chosen_at: string | null; created_at: string;
}

export async function addOffer(
  db: D1Database, o: { orderId: number; vendorId: number; currency: string; priceCents: number; deliveryCents: number; otherCents: number; arrivesAt: string; note?: string | null }, now: Date = new Date(),
): Promise<OfferRow> {
  return (await db
    .prepare(`INSERT INTO printer_offers (order_id, vendor_id, currency, price_cents, delivery_cents, other_cents, arrives_at, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(o.orderId, o.vendorId, o.currency, o.priceCents, o.deliveryCents, o.otherCents, o.arrivesAt, o.note ?? null, now.toISOString())
    .first<OfferRow>())!;
}

export async function listOffers(db: D1Database, orderId: number): Promise<OfferRow[]> {
  return (await db.prepare("SELECT * FROM printer_offers WHERE order_id = ? ORDER BY id").bind(orderId).all<OfferRow>()).results;
}

export async function deleteOffer(db: D1Database, id: number): Promise<boolean> {
  return (await db.prepare("DELETE FROM printer_offers WHERE id = ? AND chosen_at IS NULL").bind(id).run()).meta.changes === 1;
}

/** Landed cost in grosze (price + delivery + other, at NBP); offers arriving after the deadline rank after on-time ones; no rate, no rank. */
export function rankOffers(offers: OfferRow[], rate: (code: string) => number | null, deliverBy: string) {
  const deadline = deliverBy.slice(0, 10);
  const rows = offers.map((offer) => {
    const r = rate(offer.currency);
    const landedGrosze = r === null ? null : Math.round((offer.price_cents + offer.delivery_cents + offer.other_cents) * r);
    return { offer, landedGrosze, late: offer.arrives_at > deadline };
  });
  return rows.sort((a, b) =>
    Number(a.landedGrosze === null) - Number(b.landedGrosze === null)
    || Number(a.late) - Number(b.late)
    || (a.landedGrosze ?? 0) - (b.landedGrosze ?? 0)
    || a.offer.id - b.offer.id);
}

/** Records the offer's landed cost through giveCost() (as /cost does), then owes the printer the offer's price plus delivery. */
export async function useOffer(env: Env, offerId: number, now: Date = new Date()): Promise<string> {
  const offer = await env.DB.prepare("SELECT * FROM printer_offers WHERE id = ?").bind(offerId).first<OfferRow>();
  if (!offer) return "No such offer.";
  if (offer.chosen_at) return "This offer was already used.";
  const cost = await env.DB.prepare("SELECT id FROM escalations WHERE order_id = ? AND kind = 'cost' AND status = 'open' ORDER BY id DESC LIMIT 1").bind(offer.order_id).first<{ id: number }>();
  if (!cost) return "This order has no open cost request.";
  const r = await plnPer(env.DB, offer.currency, now);
  if (r === null) return `No fresh NBP rate for ${offer.currency}.`;
  const landed = Math.round((offer.price_cents + offer.delivery_cents + offer.other_cents) * r) / 100;
  // Only the offer number reaches the order agent; never the printer's name.
  const reply = await giveCost(env, cost.id, landed, `offer #${offer.id}`, { currency: "PLN", vendorId: offer.vendor_id, now });
  const job = await vendorJobFor(env.DB, offer.order_id);
  if (job && job.vendor_id === offer.vendor_id && job.status === "proposed") {
    await env.DB.prepare("UPDATE vendor_jobs SET cost_currency = ?, cost_cents = ? WHERE order_id = ? AND status = 'proposed'")
      .bind(offer.currency, offer.price_cents + offer.delivery_cents, offer.order_id).run();
  }
  if (reply.startsWith(`#${cost.id}:`) || reply.includes("could not be told")) {
    await env.DB.prepare("UPDATE printer_offers SET chosen_at = ? WHERE id = ?").bind(now.toISOString(), offer.id).run();
  }
  return reply;
}
