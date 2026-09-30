import { isUniqueError } from "./treasury";

export const PAY_CURRENCIES = ["PLN", "EUR", "GBP", "USD", "INR"] as const;
export type PayCurrency = (typeof PAY_CURRENCIES)[number];
export type SupplierPaymentStatus = "due" | "cashing_out" | "ready" | "paid" | "cancelled";
export type PayMethod = "card" | "blik" | "transfer";

/** A printer payment the owner makes by hand: created when a deposit completes on the owner path. */
export interface SupplierPaymentRow {
  id: number;
  order_id: number;
  vendor_id: number | null;
  currency: string;
  amount_cents: number;
  status: SupplierPaymentStatus;
  method: PayMethod | null;
  reference: string | null;
  note: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** USDC sold on Kraken and withdrawn to the owner's own account for one supplier payment. */
export interface CashoutRow {
  id: number;
  supplier_payment_id: number;
  fiat: "EUR" | "GBP";
  fiat_cents: number;
  client_order_id: string;
  status: "queued" | "sold" | "withdrawn" | "failed";
  sold_units: number | null;
  order_ref: string | null;
  withdrawal_ref: string | null;
  fee_cents: number | null;
  withdraw_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_WITHDRAW_ATTEMPTS = 3;

export async function createSupplierPayment(
  db: D1Database, p: { orderId: number; vendorId: number | null; currency: string; amountCents: number }, now: Date = new Date(),
): Promise<SupplierPaymentRow> {
  const at = now.toISOString();
  await db
    .prepare("INSERT OR IGNORE INTO supplier_payments (order_id, vendor_id, currency, amount_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p.orderId, p.vendorId, p.currency, p.amountCents, at, at)
    .run();
  const row = await supplierPaymentForOrder(db, p.orderId);
  if (!row) throw new Error("supplier payment insert returned no row");
  return row;
}

export async function getSupplierPayment(db: D1Database, id: number): Promise<SupplierPaymentRow | null> {
  return db.prepare("SELECT * FROM supplier_payments WHERE id = ?").bind(id).first<SupplierPaymentRow>();
}

export async function supplierPaymentForOrder(db: D1Database, orderId: number): Promise<SupplierPaymentRow | null> {
  return db.prepare("SELECT * FROM supplier_payments WHERE order_id = ?").bind(orderId).first<SupplierPaymentRow>();
}

export async function setSupplierPaymentStatus(
  db: D1Database, id: number, from: SupplierPaymentStatus[], to: SupplierPaymentStatus,
  extra: { method?: PayMethod; reference?: string | null; note?: string | null; paidAt?: string } = {}, now: Date = new Date(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE supplier_payments SET status = ?, method = COALESCE(?, method), reference = COALESCE(?, reference), note = COALESCE(?, note),
         paid_at = COALESCE(?, paid_at), updated_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
    )
    .bind(to, extra.method ?? null, extra.reference ?? null, extra.note ?? null, extra.paidAt ?? null, now.toISOString(), id, ...from)
    .run();
  return res.meta.changes === 1;
}

/** Queues a cash-out for a `due` payment and marks it cashing_out; null when the payment isn't due or one is already live. */
export async function queueCashout(
  db: D1Database, spId: number, c: { fiat: "EUR" | "GBP"; fiatCents: number }, now: Date = new Date(),
): Promise<CashoutRow | null> {
  const at = now.toISOString();
  try {
    const results = await db.batch([
      db.prepare("UPDATE supplier_payments SET status = 'cashing_out', updated_at = ? WHERE id = ? AND status = 'due'").bind(at, spId),
      db
        .prepare(
          `INSERT INTO cashouts (supplier_payment_id, fiat, fiat_cents, client_order_id, created_at, updated_at)
           SELECT id, ?, ?, ?, ?, ? FROM supplier_payments WHERE id = ? AND status = 'cashing_out' AND changes() = 1 RETURNING *`,
        )
        .bind(c.fiat, c.fiatCents, crypto.randomUUID(), at, at, spId),
    ]);
    return (results[1].results[0] as CashoutRow | undefined) ?? null;
  } catch (err) {
    if (isUniqueError(err)) return null;
    throw err;
  }
}

export async function getCashout(db: D1Database, id: number): Promise<CashoutRow | null> {
  return db.prepare("SELECT * FROM cashouts WHERE id = ?").bind(id).first<CashoutRow>();
}

export async function latestCashout(db: D1Database, spId: number): Promise<CashoutRow | null> {
  return db.prepare("SELECT * FROM cashouts WHERE supplier_payment_id = ? ORDER BY id DESC LIMIT 1").bind(spId).first<CashoutRow>();
}

/** Cash-outs the runner still has work on, oldest first. */
export async function liveCashouts(db: D1Database, limit = 10): Promise<CashoutRow[]> {
  return (await db.prepare("SELECT * FROM cashouts WHERE status IN ('queued', 'sold') ORDER BY id LIMIT ?").bind(limit).all<CashoutRow>()).results;
}

export async function recordCashoutSold(db: D1Database, id: number, r: { orderRef: string | null; soldUnits: number }, now: Date = new Date()): Promise<CashoutRow | null> {
  return db
    .prepare("UPDATE cashouts SET status = 'sold', order_ref = ?, sold_units = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *")
    .bind(r.orderRef, r.soldUnits, now.toISOString(), id)
    .first<CashoutRow>();
}

export async function recordCashoutWithdrawn(db: D1Database, id: number, r: { withdrawalRef: string | null; feeCents: number | null }, now: Date = new Date()): Promise<CashoutRow | null> {
  const at = now.toISOString();
  const results = await db.batch([
    db.prepare("UPDATE cashouts SET status = 'withdrawn', withdrawal_ref = ?, fee_cents = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'sold' RETURNING *")
      .bind(r.withdrawalRef, r.feeCents, at, id),
    db.prepare(
      `UPDATE supplier_payments SET status = 'ready', updated_at = ? WHERE status = 'cashing_out'
         AND id = (SELECT supplier_payment_id FROM cashouts WHERE id = ? AND status = 'withdrawn' AND updated_at = ?)`,
    ).bind(at, id, at),
  ]);
  return (results[0].results[0] as CashoutRow | undefined) ?? null;
}

/** Before the sale the payment is free for a new cash-out; after it, the payment stays cashing_out (Retry withdrawal). */
export async function recordCashoutFailed(db: D1Database, id: number, error: string, now: Date = new Date()): Promise<CashoutRow | null> {
  const at = now.toISOString();
  const results = await db.batch([
    db.prepare("UPDATE cashouts SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'sold') RETURNING *")
      .bind(error.slice(0, 500), at, id),
    db.prepare(
      `UPDATE supplier_payments SET status = 'due', updated_at = ? WHERE status = 'cashing_out'
         AND id = (SELECT supplier_payment_id FROM cashouts WHERE id = ? AND status = 'failed' AND sold_units IS NULL AND updated_at = ?)`,
    ).bind(at, id, at),
  ]);
  return (results[0].results[0] as CashoutRow | undefined) ?? null;
}

/** One failed withdrawal attempt of a sold cash-out; the third fails it. Null when it isn't sold. */
export async function recordWithdrawError(db: D1Database, id: number, error: string, now: Date = new Date()): Promise<{ row: CashoutRow; exhausted: boolean } | null> {
  const row = await db
    .prepare(
      `UPDATE cashouts SET withdraw_attempts = withdraw_attempts + 1, error = ?, updated_at = ?,
         status = CASE WHEN withdraw_attempts + 1 >= ? THEN 'failed' ELSE status END
       WHERE id = ? AND status = 'sold' RETURNING *`,
    )
    .bind(error.slice(0, 500), now.toISOString(), MAX_WITHDRAW_ATTEMPTS, id)
    .first<CashoutRow>();
  return row ? { row, exhausted: row.status === "failed" } : null;
}

/** A cash-out that failed after its sale goes back to `sold`, so the runner withdraws (and never sells) again. */
export async function retryWithdrawal(db: D1Database, id: number, now: Date = new Date()): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `UPDATE cashouts SET status = 'sold', withdraw_attempts = 0, error = NULL, updated_at = ? WHERE id = ? AND status = 'failed' AND sold_units IS NOT NULL
           AND supplier_payment_id IN (SELECT id FROM supplier_payments WHERE status = 'cashing_out')`,
      )
      .bind(now.toISOString(), id)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    if (isUniqueError(err)) return false;
    throw err;
  }
}

/**
 * What to withdraw for a printer payment: EUR as is; GBP as is when GBP withdrawals are enabled; anything else in EUR at the
 * NBP mid rates plus a buffer (the owner's bank converts at its own rate), rounded up. Null without a fresh rate.
 */
export function cashoutAmount(
  p: { currency: string; amountCents: number }, plnPer: (code: string) => number | null, opts: { gbpEnabled: boolean; buffer: number },
): { fiat: "EUR" | "GBP"; fiatCents: number } | null {
  if (p.currency === "EUR") return { fiat: "EUR", fiatCents: p.amountCents };
  if (p.currency === "GBP" && opts.gbpEnabled) return { fiat: "GBP", fiatCents: p.amountCents };
  const from = plnPer(p.currency);
  const eur = plnPer("EUR");
  if (from === null || eur === null) return null;
  return { fiat: "EUR", fiatCents: Math.ceil((p.amountCents * from * (1 + opts.buffer)) / eur - 1e-9) };
}

export async function logAdminAction(
  db: D1Database, a: { email: string | null; action: string; target: string; detail?: unknown }, now: Date = new Date(),
): Promise<void> {
  await db
    .prepare("INSERT INTO admin_actions (email, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(a.email, a.action, a.target, a.detail === undefined ? null : JSON.stringify(a.detail), now.toISOString())
    .run();
}

export async function touchRunner(db: D1Database, now: Date = new Date()): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO runner_state (key, value) VALUES ('last_seen', ?)").bind(now.toISOString()).run();
}

export async function runnerLastSeen(db: D1Database): Promise<string | null> {
  return (await db.prepare("SELECT value FROM runner_state WHERE key = 'last_seen'").first<{ value: string }>())?.value ?? null;
}
