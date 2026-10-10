// How a printer offer reaches the venue: 1-3 options per offer, one in use. The offer's delivery_cents, arrives_at and
// delivery_method always hold the option in use, so landed cost, lateness and ranking read the offer as before.

export const DELIVERY_METHODS = ["pickup", "printer_courier", "courier", "same_day", "parcel_locker"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** Labels for the owner (admin, panel). */
export const DELIVERY_LABELS: Record<DeliveryMethod, string> = {
  pickup: "Pickup at the printer", printer_courier: "The printer's courier", courier: "Courier", same_day: "Same-day courier", parcel_locker: "Parcel locker",
};

/** How the order agent reads a method. */
export const DELIVERY_WORDS: Record<DeliveryMethod, string> = {
  pickup: "pickup at the printer", printer_courier: "printer's courier", courier: "courier", same_day: "same-day courier", parcel_locker: "parcel locker",
};

const HOST_WORDS: Record<DeliveryMethod, string> = {
  pickup: "pickup at the printer", printer_courier: "by the printer's courier", courier: "by courier", same_day: "by same-day courier", parcel_locker: "to a parcel locker",
};

export const isDeliveryMethod = (m: unknown): m is DeliveryMethod => typeof m === "string" && (DELIVERY_METHODS as readonly string[]).includes(m);

export interface DeliveryRow {
  id: number;
  offer_id: number;
  method: DeliveryMethod;
  /** In the offer's currency. */
  cost_cents: number;
  arrives_at: string;
  note: string | null;
  created_at: string;
}

export async function addDeliveries(
  db: D1Database, offerId: number, options: Array<{ method: DeliveryMethod; costCents: number; arrivesAt: string; note?: string | null }>, now: Date = new Date(),
): Promise<DeliveryRow[]> {
  if (!options.length) return [];
  const res = await db.batch(options.map((o) =>
    db.prepare("INSERT INTO offer_deliveries (offer_id, method, cost_cents, arrives_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
      .bind(offerId, o.method, o.costCents, o.arrivesAt, o.note ?? null, now.toISOString())));
  return res.map((r) => (r.results as DeliveryRow[])[0]);
}

export async function deliveriesFor(db: D1Database, offerIds: number[]): Promise<DeliveryRow[]> {
  if (!offerIds.length) return [];
  return (await db.prepare(`SELECT * FROM offer_deliveries WHERE offer_id IN (${offerIds.map(() => "?").join(", ")}) ORDER BY id`).bind(...offerIds).all<DeliveryRow>()).results;
}

/** The cheapest option arriving by `deadline` (YYYY-MM-DD), the earlier one on a tie; when none is on time, the earliest arrival. */
export function bestDelivery(rows: DeliveryRow[], deadline: string): DeliveryRow | null {
  const onTime = rows.filter((r) => r.arrives_at <= deadline);
  const pool = onTime.length ? onTime : rows;
  const sorted = [...pool].sort((a, b) => onTime.length
    ? a.cost_cents - b.cost_cents || a.arrives_at.localeCompare(b.arrives_at) || a.id - b.id
    : a.arrives_at.localeCompare(b.arrives_at) || a.cost_cents - b.cost_cents || a.id - b.id);
  return sorted[0] ?? null;
}

/** Puts an unused offer on one of its own options; false for another offer's option or a used offer. */
export async function setOfferDelivery(db: D1Database, offerId: number, deliveryId: number): Promise<boolean> {
  const d = await db.prepare("SELECT * FROM offer_deliveries WHERE id = ? AND offer_id = ?").bind(deliveryId, offerId).first<DeliveryRow>();
  if (!d) return false;
  const r = await db
    .prepare("UPDATE printer_offers SET delivery_cents = ?, arrives_at = ?, delivery_method = ?, delivery_id = ? WHERE id = ? AND chosen_at IS NULL")
    .bind(d.cost_cents, d.arrives_at, d.method, d.id, offerId)
    .run();
  return r.meta.changes === 1;
}

const dayMonth = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The sentence the host reads under the quote: "Delivery: by courier, arrives 14 Oct." */
export function deliveryLine(method: string, arrivesAt: string): string {
  if (!isDeliveryMethod(method)) return `Delivery: arrives ${dayMonth(arrivesAt)}.`;
  return method === "pickup" ? `Delivery: ${HOST_WORDS.pickup} from ${dayMonth(arrivesAt)}.` : `Delivery: ${HOST_WORDS[method]}, arrives ${dayMonth(arrivesAt)}.`;
}

/** The delivery of the offer last used for this order, for the order page. */
export async function usedDelivery(db: D1Database, orderId: number): Promise<{ method: string; arrivesAt: string } | null> {
  const r = await db
    .prepare("SELECT delivery_method, arrives_at FROM printer_offers WHERE order_id = ? AND chosen_at IS NOT NULL AND delivery_method IS NOT NULL ORDER BY chosen_at DESC, id DESC LIMIT 1")
    .bind(orderId)
    .first<{ delivery_method: string; arrives_at: string }>();
  return r ? { method: r.delivery_method, arrivesAt: r.arrives_at } : null;
}
