import { isAddress, type Token } from "./money";

export type ObligationKind = "printer_cost" | "refund" | "reserve";
/** "settled": the owner handled it outside the agent (a reject, or an approved non-USDC obligation). "cancelled" is unused. */
export type ObligationStatus = "open" | "approved" | "queued" | "paid" | "failed" | "escalated" | "waiting" | "settled" | "cancelled";

export interface ObligationRow {
  id: number;
  order_id: number | null;
  kind: ObligationKind;
  token: Token;
  amount_units: number;
  destination: string;
  chain: string;
  due_at: string;
  status: ObligationStatus;
  approved_by: string | null;
  source_ref: string;
  note: string | null;
  vendor_id: number | null;
  created_at: string;
  settled_at: string | null;
}

export interface PayoutRow {
  id: number;
  obligation_id: number;
  method: "transfer" | "bridge";
  chain: string;
  token: Token;
  amount_units: number;
  destination: string;
  idempotency_key: string;
  status: "queued" | "sent" | "denied" | "failed";
  result_ref: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TreasuryPolicy {
  perTxUnits: number;
  dailyUnits: number;
  reserveMinBps: number;
  reserveMaxBps: number;
  /** "ARC" for a same-chain transfer; any other Circle chain code (e.g. "MATIC") bridges with CCTP forwarding. */
  payoutChain: string;
  payoutAddress: string | null;
  reserveAddress: string | null;
}

export function loadTreasuryPolicy(vars: Record<string, unknown>): TreasuryPolicy {
  const usdc = (key: string, fallback: number): number => {
    const raw = vars[key];
    if (raw === undefined || raw === "") return fallback * 1_000_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${String(raw)}"`);
    return Math.round(n * 1_000_000);
  };
  const bps = (key: string, fallback: number): number => {
    const raw = vars[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`${key} must be 0-10000, got "${String(raw)}"`);
    return n;
  };
  const addr = (key: string): string | null => (isAddress(vars[key]) ? (vars[key] as string) : null);
  const payoutChain = String(vars.PAYOUT_CHAIN || "ARC").trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,24}$/.test(payoutChain)) throw new Error(`PAYOUT_CHAIN is not a chain code, got "${String(vars.PAYOUT_CHAIN)}"`);
  const policy: TreasuryPolicy = {
    perTxUnits: usdc("TREASURY_PER_TX_USDC", 500),
    dailyUnits: usdc("TREASURY_DAILY_USDC", 1500),
    reserveMinBps: bps("TREASURY_RESERVE_MIN_BPS", 1000),
    reserveMaxBps: bps("TREASURY_RESERVE_MAX_BPS", 3000),
    payoutChain,
    payoutAddress: addr("PAYOUT_ADDRESS"),
    reserveAddress: addr("RESERVE_ADDRESS"),
  };
  if (policy.reserveMinBps > policy.reserveMaxBps) throw new Error("TREASURY_RESERVE_MIN_BPS must not exceed TREASURY_RESERVE_MAX_BPS");
  return policy;
}

/** The printer's PLN cost in token units at the quote's rate plus the FX buffer, rounded up. */
export function printerCostUnits(q: { cost_pln_grosze: number; pln_per_unit: number }, fxBuffer: number): number {
  return Math.ceil((q.cost_pln_grosze * 10_000 * (1 + fxBuffer)) / q.pln_per_unit - 1e-6);
}

export type NewObligation = { orderId: number | null; kind: ObligationKind; token: Token; amountUnits: number; destination: string; chain: string; dueAt: Date; sourceRef: string; status?: "open" | "escalated" | "waiting"; note?: string; vendorId?: number };

/** One obligation per source ref: `created` is false when the ref already existed (its row is returned unchanged). */
export async function insertObligation(db: D1Database, o: NewObligation, now: Date = new Date()): Promise<{ obligation: ObligationRow; created: boolean }> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO obligations (order_id, kind, token, amount_units, destination, chain, due_at, status, source_ref, note, vendor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(o.orderId, o.kind, o.token, o.amountUnits, o.destination, o.chain, o.dueAt.toISOString(), o.status ?? "open", o.sourceRef, o.note ?? null, o.vendorId ?? null, now.toISOString())
    .run();
  const row = await db.prepare("SELECT * FROM obligations WHERE source_ref = ?").bind(o.sourceRef).first<ObligationRow>();
  if (!row) throw new Error("obligation insert returned no row");
  return { obligation: row, created: res.meta.changes === 1 };
}

export async function createObligation(db: D1Database, o: NewObligation, now: Date = new Date()): Promise<ObligationRow> {
  return (await insertObligation(db, o, now)).obligation;
}

export async function getObligation(db: D1Database, id: number): Promise<ObligationRow | null> {
  return db.prepare("SELECT * FROM obligations WHERE id = ?").bind(id).first<ObligationRow>();
}

export async function getObligationByRef(db: D1Database, sourceRef: string): Promise<ObligationRow | null> {
  return db.prepare("SELECT * FROM obligations WHERE source_ref = ?").bind(sourceRef).first<ObligationRow>();
}

/** An order's obligations to a printer that wait for /printed (milestone 2). */
export async function waitingVendorObligations(db: D1Database, orderId: number): Promise<ObligationRow[]> {
  return (await db
    .prepare("SELECT * FROM obligations WHERE order_id = ? AND status = 'waiting' AND vendor_id IS NOT NULL ORDER BY id")
    .bind(orderId)
    .all<ObligationRow>()).results;
}

/** An order's obligations to a printer that nothing was ever paid on: waiting for /printed, or open and never queued. */
export async function unpaidVendorObligations(db: D1Database, orderId: number): Promise<ObligationRow[]> {
  return (await db
    .prepare(
      `SELECT * FROM obligations WHERE order_id = ? AND vendor_id IS NOT NULL
         AND (status = 'waiting' OR (status = 'open' AND NOT EXISTS (SELECT 1 FROM payouts WHERE obligation_id = obligations.id)))
       ORDER BY id`,
    )
    .bind(orderId)
    .all<ObligationRow>()).results;
}

/** An order's obligations to a printer (its milestones), oldest first, each with its latest payout's status and ref (null without one). */
export async function vendorObligations(
  db: D1Database, orderId: number,
): Promise<Array<ObligationRow & { payout_status: PayoutRow["status"] | null; payout_ref: string | null }>> {
  return (await db
    .prepare(
      `SELECT o.*, p.status AS payout_status, p.result_ref AS payout_ref FROM obligations o
         LEFT JOIN payouts p ON p.id = (SELECT MAX(id) FROM payouts WHERE obligation_id = o.id)
       WHERE o.order_id = ? AND o.vendor_id IS NOT NULL ORDER BY o.id`,
    )
    .bind(orderId)
    .all<ObligationRow & { payout_status: PayoutRow["status"] | null; payout_ref: string | null }>()).results;
}

/** The id of an obligation's latest payout, or null when it never had one. */
export async function latestPayoutId(db: D1Database, obligationId: number): Promise<number | null> {
  return (await db.prepare("SELECT MAX(id) AS id FROM payouts WHERE obligation_id = ?").bind(obligationId).first<{ id: number | null }>())?.id ?? null;
}

export async function listObligations(db: D1Database, statuses: ObligationStatus[], limit = 50): Promise<ObligationRow[]> {
  return (await db
    .prepare(`SELECT * FROM obligations WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY id LIMIT ?`)
    .bind(...statuses, limit)
    .all<ObligationRow>()).results;
}

export async function setObligationStatus(
  db: D1Database, id: number, from: ObligationStatus[], to: ObligationStatus, extra: { approvedBy?: string } = {},
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE obligations SET status = ?, approved_by = COALESCE(?, approved_by) WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
    .bind(to, extra.approvedBy ?? null, id, ...from)
    .run();
  return res.meta.changes === 1;
}

/**
 * The owner's decision on an obligation's approval escalation. Approve moves a USDC obligation to approved (the treasury pays it)
 * and any other token to settled (the treasury can't pay it); reject means the owner handles it, so it is settled too.
 * A failed obligation moves only for the escalation of its latest payout, and an escalation without a payoutId moves nothing once
 * a payout exists, so a stale /resend can't reopen a newer failure or re-approve after a newer denial.
 */
export async function decideObligation(
  db: D1Database, id: number, decision: "approved" | "rejected", payoutId: number | null,
): Promise<ObligationRow | null> {
  const ob = await getObligation(db, id);
  if (!ob) return null;
  const from: ObligationStatus[] = ["escalated", "open"];
  if (payoutId === null) {
    // Every approval without a payoutId comes before any payout: once one exists, only a payout's own escalation decides.
    if (await db.prepare("SELECT 1 AS n FROM payouts WHERE obligation_id = ? LIMIT 1").bind(id).first()) return ob;
  } else {
    const newer = await db.prepare("SELECT 1 AS n FROM payouts WHERE obligation_id = ? AND id > ? LIMIT 1").bind(id, payoutId).first();
    if (!newer) from.push("failed");
  }
  const to: ObligationStatus = decision === "approved" && ob.token === "USDC" ? "approved" : "settled";
  await setObligationStatus(db, id, from, to, decision === "approved" ? { approvedBy: "owner" } : {});
  return getObligation(db, id);
}

export async function setObligationNote(db: D1Database, id: number, note: string): Promise<void> {
  await db.prepare("UPDATE obligations SET note = ? WHERE id = ?").bind(note.slice(0, 500), id).run();
}

export const isUniqueError = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

/** Queues one payout for an obligation that is open, approved or failed; null when it wasn't (or one is already live). */
export async function queuePayout(db: D1Database, ob: ObligationRow, now: Date = new Date()): Promise<PayoutRow | null> {
  const at = now.toISOString();
  try {
    const results = await db.batch([
      db.prepare("UPDATE obligations SET status = 'queued' WHERE id = ? AND status IN ('open', 'approved', 'failed')").bind(ob.id),
      db
        .prepare(
          `INSERT INTO payouts (obligation_id, method, chain, token, amount_units, destination, idempotency_key, created_at, updated_at)
           SELECT id, CASE WHEN chain = 'ARC' THEN 'transfer' ELSE 'bridge' END, chain, token, amount_units, destination, ?, ?, ?
           FROM obligations WHERE id = ? AND status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM payouts WHERE obligation_id = obligations.id AND status IN ('queued', 'sent')) RETURNING *`,
        )
        .bind(crypto.randomUUID(), at, at, ob.id),
    ]);
    return (results[1].results[0] as PayoutRow | undefined) ?? null;
  } catch (err) {
    if (isUniqueError(err)) return null;
    throw err;
  }
}

/** Records the runner's result for a queued payout; null when the payout was not queued (duplicate or late result). */
export async function recordPayoutResult(
  db: D1Database, id: number, r: { status: "sent" | "denied" | "failed"; ref?: string | null; error?: string | null }, now: Date = new Date(),
): Promise<{ payout: PayoutRow; obligation: ObligationRow } | null> {
  const at = now.toISOString();
  const obligationStatus: ObligationStatus = r.status === "sent" ? "paid" : r.status === "denied" ? "escalated" : "failed";
  const results = await db.batch([
    db.prepare("UPDATE payouts SET status = ?, result_ref = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *")
      .bind(r.status, r.ref ?? null, r.error ?? null, at, id),
    // Only the obligation of the payout that was just updated (same batch, same timestamp) moves.
    db.prepare(
      `UPDATE obligations SET status = ?, settled_at = CASE WHEN ? = 'paid' THEN ? ELSE settled_at END
       WHERE status = 'queued' AND id = (SELECT obligation_id FROM payouts WHERE id = ? AND status = ? AND updated_at = ?)
         AND NOT EXISTS (SELECT 1 FROM payouts p2 WHERE p2.obligation_id = obligations.id AND p2.id > ?)`,
    ).bind(obligationStatus, obligationStatus, at, id, r.status, at, id),
  ]);
  const payout = results[0].results[0] as PayoutRow | undefined;
  if (!payout) return null;
  const obligation = await getObligation(db, payout.obligation_id);
  return obligation ? { payout, obligation } : null;
}

/** Queued payouts to a printer that is no longer a partner at the payout's address and chain (paused, gone, or registered elsewhere). */
export async function payoutsToWithhold(db: D1Database): Promise<Array<{ payoutId: number; vendorId: number }>> {
  return (await db
    .prepare(
      `SELECT p.id AS payoutId, o.vendor_id AS vendorId FROM payouts p
         JOIN obligations o ON o.id = p.obligation_id
         LEFT JOIN vendors v ON v.id = o.vendor_id
       WHERE p.status = 'queued' AND o.vendor_id IS NOT NULL
         AND (v.id IS NULL OR v.status != 'partner' OR v.payout_address IS NULL OR v.payout_chain IS NULL
           OR lower(v.payout_address) != lower(p.destination) OR v.payout_chain != p.chain)
       ORDER BY p.id`,
    )
    .all<{ payoutId: number; vendorId: number }>()).results;
}

export async function listQueuedPayouts(db: D1Database, limit = 20): Promise<PayoutRow[]> {
  return (await db.prepare("SELECT * FROM payouts WHERE status = 'queued' ORDER BY id LIMIT ?").bind(limit).all<PayoutRow>()).results;
}

/** Units queued (any age) plus units sent in the 24 hours before `now`. */
export async function payoutsLast24h(db: D1Database, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM payouts WHERE status = 'queued' OR (status = 'sent' AND updated_at > ? AND updated_at <= ?)")
    .bind(since, now.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Payouts still queued `hours` after they were queued (the wallet runner may be down), oldest first. */
export async function staleQueuedPayouts(db: D1Database, now: Date = new Date(), hours = 2, limit = 10): Promise<PayoutRow[]> {
  const before = new Date(now.getTime() - hours * 3_600_000).toISOString();
  return (await db.prepare("SELECT * FROM payouts WHERE status = 'queued' AND created_at < ? ORDER BY id LIMIT ?").bind(before, limit).all<PayoutRow>()).results;
}

/** Closed orders a sweep can succeed on (a USDC printer cost is recorded) with no reserve obligation yet, newest first. */
export async function unsweptClosedOrders(db: D1Database, limit = 10): Promise<number[]> {
  return (await db
    .prepare(
      `SELECT id FROM orders WHERE status = 'closed'
         AND NOT EXISTS (SELECT 1 FROM obligations WHERE order_id = orders.id AND kind = 'reserve')
         AND EXISTS (SELECT 1 FROM obligations c WHERE c.order_id = orders.id AND c.kind = 'printer_cost' AND c.token = 'USDC')
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number }>()).results.map((r) => r.id);
}

export async function queuedUnits(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM payouts WHERE status = 'queued'").first<{ n: number }>())?.n ?? 0;
}

/** What the order brought in (surplus excluded: it is refunded) and its printer cost obligations, whatever their status (paid by the agent or by the owner). */
export async function orderMargin(db: D1Database, orderId: number): Promise<{ status: string; token: Token; receivedUnits: number; printerCostUnits: number } | null> {
  const order = await db.prepare("SELECT status FROM orders WHERE id = ?").bind(orderId).first<{ status: string }>();
  if (!order) return null;
  const received = await db
    .prepare("SELECT token, COALESCE(SUM(MIN(paid_units, amount_units)), 0) AS n FROM payment_requests WHERE order_id = ? AND status != 'cancelled' GROUP BY token ORDER BY n DESC LIMIT 1")
    .bind(orderId)
    .first<{ token: Token; n: number }>();
  const cost = await db
    .prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM obligations WHERE order_id = ? AND kind = 'printer_cost'")
    .bind(orderId)
    .first<{ n: number }>();
  return { status: order.status, token: received?.token ?? "USDC", receivedUnits: received?.n ?? 0, printerCostUnits: cost?.n ?? 0 };
}

export async function insertTreasuryDecision(
  db: D1Database,
  d: { orderId: number | null; tool: string; reason: string; input: unknown; verdict: string; outcome: string; detail?: string },
  now: Date = new Date(),
): Promise<void> {
  // An order id that doesn't exist is stored as null rather than failing the log.
  await db
    .prepare(
      `INSERT INTO treasury_decisions (order_id, tool, reason, input_json, verdict, outcome, detail, created_at)
       VALUES ((SELECT id FROM orders WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(d.orderId, d.tool, d.reason, JSON.stringify(d.input ?? null), d.verdict, d.outcome, d.detail ?? null, now.toISOString())
    .run();
}
