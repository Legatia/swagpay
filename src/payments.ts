import { MAX_TAG, UNITS_PER_CENT, taggedUnits, type Token } from "./money";

export interface PaymentRequestRow {
  id: number;
  order_id: number;
  quote_id: number;
  stage: "deposit" | "balance";
  token: Token;
  amount_units: number;
  tag: number;
  paid_units: number;
  status: "open" | "paid" | "cancelled";
  created_at: string;
  paid_at: string | null;
}

export interface TransferRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  token: Token;
  from_address: string;
  amount_units: number;
  request_id: number | null;
  created_at: string;
}

export interface NewTransfer {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  token: Token;
  from: string;
  amountUnits: number;
}

export type TransferOutcome =
  | { kind: "duplicate" }
  | { kind: "unmatched"; transfer: TransferRow }
  | { kind: "matched"; transfer: TransferRow; request: PaymentRequestRow };

const isUniqueError = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
const randomTag = () => 1 + Math.floor(Math.random() * MAX_TAG);

export async function createPaymentRequest(
  db: D1Database,
  r: { orderId: number; quoteId: number; stage: "deposit" | "balance"; token: Token; cents: number },
  now: Date = new Date(),
  nextTag: () => number = randomTag,
): Promise<PaymentRequestRow> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tag = nextTag();
    try {
      const row = await db
        .prepare("INSERT INTO payment_requests (order_id, quote_id, stage, token, amount_units, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .bind(r.orderId, r.quoteId, r.stage, r.token, taggedUnits(r.cents, tag), tag, now.toISOString())
        .first<PaymentRequestRow>();
      if (!row) throw new Error("payment request insert returned no row");
      return row;
    } catch (err) {
      if (!isUniqueError(err)) throw err;
    }
  }
  throw new Error("no free payment tag after 20 attempts");
}

export async function getPaymentRequest(db: D1Database, id: number): Promise<PaymentRequestRow | null> {
  return db.prepare("SELECT * FROM payment_requests WHERE id = ?").bind(id).first<PaymentRequestRow>();
}

export async function listPaymentRequests(db: D1Database, orderId: number): Promise<PaymentRequestRow[]> {
  return (await db.prepare("SELECT * FROM payment_requests WHERE order_id = ? ORDER BY id").bind(orderId).all<PaymentRequestRow>()).results;
}

async function getTransfer(db: D1Database, txHash: string, logIndex: number): Promise<TransferRow | null> {
  return db.prepare("SELECT * FROM transfers WHERE tx_hash = ? AND log_index = ?").bind(txHash, logIndex).first<TransferRow>();
}

/** Links a payer-reported transaction hash to a request. "taken" when another request already claimed it. */
export async function addClaim(db: D1Database, requestId: number, txHash: string, now: Date = new Date()): Promise<"stored" | "taken"> {
  const hash = txHash.toLowerCase();
  const existing = await db.prepare("SELECT request_id FROM payment_claims WHERE tx_hash = ?").bind(hash).first<{ request_id: number }>();
  if (existing) return existing.request_id === requestId ? "stored" : "taken";
  try {
    await db.prepare("INSERT INTO payment_claims (tx_hash, request_id, created_at) VALUES (?, ?, ?)").bind(hash, requestId, now.toISOString()).run();
    return "stored";
  } catch (err) {
    if (isUniqueError(err)) return "taken";
    throw err;
  }
}

/** The request a transfer pays: a claimed hash first, then the exact amount still due, then the tag. */
export async function matchTransfer(db: D1Database, t: { txHash: string; token: Token; amountUnits: number }): Promise<PaymentRequestRow | null> {
  const claimed = await db
    .prepare("SELECT r.* FROM payment_claims c JOIN payment_requests r ON r.id = c.request_id WHERE c.tx_hash = ? AND r.token = ? AND r.status != 'cancelled'")
    .bind(t.txHash.toLowerCase(), t.token)
    .first<PaymentRequestRow>();
  if (claimed) return claimed;
  const exact = (await db
    .prepare("SELECT * FROM payment_requests WHERE status = 'open' AND token = ? AND amount_units - paid_units = ?")
    .bind(t.token, t.amountUnits)
    .all<PaymentRequestRow>()).results;
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const tagged = (await db
    .prepare("SELECT * FROM payment_requests WHERE status = 'open' AND token = ? AND tag = ?")
    .bind(t.token, t.amountUnits % UNITS_PER_CENT)
    .all<PaymentRequestRow>()).results;
  return tagged.length === 1 ? tagged[0] : null;
}

// Credit the request only while the transfer is still unassigned, then assign it. Run both in one batch (one transaction).
const CREDIT = `UPDATE payment_requests
  SET paid_units = paid_units + ?1,
      status = CASE WHEN status = 'open' AND paid_units + ?1 >= amount_units THEN 'paid' ELSE status END,
      paid_at = CASE WHEN paid_at IS NULL AND paid_units + ?1 >= amount_units THEN ?2 ELSE paid_at END
  WHERE id = ?3 AND EXISTS (SELECT 1 FROM transfers WHERE tx_hash = ?4 AND log_index = ?5 AND request_id IS NULL)`;
const ASSIGN = "UPDATE transfers SET request_id = ?1 WHERE tx_hash = ?2 AND log_index = ?3 AND request_id IS NULL";

function creditStatements(db: D1Database, t: { txHash: string; logIndex: number; amountUnits: number }, requestId: number, now: Date): D1PreparedStatement[] {
  return [
    db.prepare(CREDIT).bind(t.amountUnits, now.toISOString(), requestId, t.txHash, t.logIndex),
    db.prepare(ASSIGN).bind(requestId, t.txHash, t.logIndex),
  ];
}

/** Stores a transfer once and credits the request it matches. */
export async function recordTransfer(db: D1Database, t: NewTransfer, now: Date = new Date()): Promise<TransferOutcome> {
  const txHash = t.txHash.toLowerCase();
  if (await getTransfer(db, txHash, t.logIndex)) return { kind: "duplicate" };
  const request = await matchTransfer(db, { txHash, token: t.token, amountUnits: t.amountUnits });
  const insert = db
    .prepare("INSERT INTO transfers (tx_hash, log_index, block_number, token, from_address, amount_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(txHash, t.logIndex, t.blockNumber, t.token, t.from.toLowerCase(), t.amountUnits, now.toISOString());
  try {
    await db.batch(request ? [insert, ...creditStatements(db, { txHash, logIndex: t.logIndex, amountUnits: t.amountUnits }, request.id, now)] : [insert]);
  } catch (err) {
    if (isUniqueError(err)) return { kind: "duplicate" };
    throw err;
  }
  const transfer = await getTransfer(db, txHash, t.logIndex);
  if (!transfer) throw new Error("transfer vanished after insert");
  if (!request) return { kind: "unmatched", transfer };
  const updated = await getPaymentRequest(db, request.id);
  if (!updated) throw new Error("payment request vanished");
  return { kind: "matched", transfer, request: updated };
}

/** Credits transfers that arrived unmatched and were claimed by a payer afterwards. */
export async function applyClaims(db: D1Database, now: Date = new Date()): Promise<TransferOutcome[]> {
  const rows = (await db
    .prepare(
      `SELECT t.tx_hash, t.log_index, t.amount_units, c.request_id AS claimed
       FROM transfers t JOIN payment_claims c ON c.tx_hash = t.tx_hash JOIN payment_requests r ON r.id = c.request_id
       WHERE t.request_id IS NULL AND r.token = t.token AND r.status != 'cancelled'
       ORDER BY t.block_number, t.log_index`,
    )
    .all<{ tx_hash: string; log_index: number; amount_units: number; claimed: number }>()).results;
  const out: TransferOutcome[] = [];
  for (const row of rows) {
    await db.batch(creditStatements(db, { txHash: row.tx_hash, logIndex: row.log_index, amountUnits: row.amount_units }, row.claimed, now));
    const transfer = await getTransfer(db, row.tx_hash, row.log_index);
    const request = await getPaymentRequest(db, row.claimed);
    if (transfer?.request_id === row.claimed && request) out.push({ kind: "matched", transfer, request });
  }
  return out;
}

/** True when the order has deposit requests and every one is paid. */
export async function depositPaid(db: D1Database, orderId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'paid'), 0) AS paid FROM payment_requests WHERE order_id = ? AND stage = 'deposit' AND status != 'cancelled'")
    .bind(orderId)
    .first<{ total: number; paid: number }>();
  return !!row && row.total > 0 && row.paid === row.total;
}
