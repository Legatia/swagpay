import type { Currency } from "./money";

export interface QuoteRow {
  id: number;
  order_id: number;
  currency: Currency;
  price_cents: number;
  deposit_cents: number;
  cost_pln_grosze: number;
  pln_per_unit: number;
  usd_per_unit: number;
  markup: number;
  /** The itemsKey of the items this quote priced. */
  items_key: string;
  status: "open" | "accepted" | "expired" | "superseded";
  issued_at: string;
  valid_until: string;
  accepted_at: string | null;
}

export interface NewQuote {
  currency: Currency;
  priceCents: number;
  depositCents: number;
  costPln: number;
  plnPerUnit: number;
  usdPerUnit: number;
  markup: number;
  /** The itemsKey of the order's items as priced. */
  itemsKey: string;
}

/** The quote the host accepted for this order, if any. */
export async function acceptedQuote(db: D1Database, orderId: number): Promise<QuoteRow | null> {
  return db.prepare("SELECT * FROM quotes WHERE order_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1").bind(orderId).first<QuoteRow>();
}

export async function createQuote(db: D1Database, orderId: number, q: NewQuote, now: Date, validUntil: Date): Promise<QuoteRow> {
  const quotable = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status IN ('draft', 'quoted'))";
  const results = await db.batch([
    db.prepare(`UPDATE quotes SET status = 'superseded' WHERE order_id = ? AND status = 'open' AND ${quotable}`).bind(orderId, orderId),
    db
      .prepare(
        `INSERT INTO quotes (order_id, currency, price_cents, deposit_cents, cost_pln_grosze, pln_per_unit, usd_per_unit, markup, items_key, issued_at, valid_until)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${quotable} RETURNING *`,
      )
      .bind(orderId, q.currency, q.priceCents, q.depositCents, Math.round(q.costPln * 100), q.plnPerUnit, q.usdPerUnit, q.markup,
        q.itemsKey, now.toISOString(), validUntil.toISOString(), orderId),
    db.prepare("UPDATE orders SET status = 'quoted' WHERE id = ? AND status IN ('draft', 'quoted')").bind(orderId),
  ]);
  const row = results[1].results[0] as QuoteRow | undefined;
  if (!row) throw new Error("the order can no longer be quoted");
  return row;
}

export async function getQuote(db: D1Database, id: number): Promise<QuoteRow | null> {
  return db.prepare("SELECT * FROM quotes WHERE id = ?").bind(id).first<QuoteRow>();
}

export async function latestQuote(db: D1Database, orderId: number): Promise<QuoteRow | null> {
  return db.prepare("SELECT * FROM quotes WHERE order_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1").bind(orderId).first<QuoteRow>();
}

function acceptStatement(db: D1Database, id: number, now: Date): D1PreparedStatement {
  return db.prepare("UPDATE quotes SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'open' RETURNING *").bind(now.toISOString(), id);
}

export async function acceptQuote(db: D1Database, id: number, now: Date): Promise<QuoteRow | null> {
  return acceptStatement(db, id, now).first<QuoteRow>();
}

/**
 * Accepts an open quote and moves its order quoted → deposit_pending in one transaction.
 * The move also requires the order's spec to be the one the caller checked, so an item change that lands in between
 * undoes the acceptance.
 */
export async function acceptQuoteForOrder(
  db: D1Database,
  quoteId: number,
  order: { id: number; spec_json: string | null },
  now: Date,
): Promise<"accepted" | "not_open" | "order_changed"> {
  const [accepted, moved] = await db.batch([
    acceptStatement(db, quoteId, now),
    db
      .prepare(
        `UPDATE orders SET status = 'deposit_pending' WHERE id = ? AND status = 'quoted' AND spec_json IS ?
         AND EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = 'accepted' AND accepted_at = ?)`,
      )
      .bind(order.id, order.spec_json, quoteId, now.toISOString()),
  ]);
  if (accepted.meta.changes !== 1) return "not_open";
  if (moved.meta.changes !== 1) {
    await reopenQuote(db, quoteId);
    return "order_changed";
  }
  return "accepted";
}

export async function reopenQuote(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE quotes SET status = 'open', accepted_at = NULL WHERE id = ? AND status = 'accepted'").bind(id).run();
}

export async function supersedeQuote(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE quotes SET status = 'superseded' WHERE id = ? AND status = 'open'").bind(id).run();
}

/**
 * Supersedes the order's open quote when it priced other items, and moves the order back to draft.
 * Returns the withdrawn quote's id, or null when there was nothing to withdraw.
 */
export async function withdrawStaleQuote(db: D1Database, orderId: number, itemsKey: string): Promise<number | null> {
  const open = await db.prepare("SELECT id, items_key FROM quotes WHERE order_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .bind(orderId).first<{ id: number; items_key: string }>();
  if (!open || open.items_key === itemsKey) return null;
  const [superseded] = await db.batch([
    db.prepare("UPDATE quotes SET status = 'superseded' WHERE id = ? AND status = 'open'").bind(open.id),
    db.prepare("UPDATE orders SET status = 'draft' WHERE id = ? AND status = 'quoted' AND NOT EXISTS (SELECT 1 FROM quotes WHERE order_id = ? AND status = 'open')")
      .bind(orderId, orderId),
  ]);
  return superseded.meta.changes === 1 ? open.id : null;
}

export async function expireQuote(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE quotes SET status = 'expired' WHERE id = ? AND status = 'open'").bind(id).run();
}
