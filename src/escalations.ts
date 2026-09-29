export type EscalationKind = "approval" | "agent" | "system";
export type EscalationStatus = "open" | "approved" | "rejected";

export interface EscalationRow {
  id: number;
  order_id: number | null;
  kind: EscalationKind;
  summary: string;
  payload_json: string;
  status: EscalationStatus;
  decision_note: string | null;
  telegram_message_id: number | null;
  created_at: string;
  decided_at: string | null;
  /** When the order's agent was told about the decision (or there was no agent to tell). */
  delivered_at: string | null;
}

/** How the owner reads a decision: an approved notice was only acknowledged. */
export const statusWord = (kind: string, status: string): string =>
  (kind === "system" || kind === "payment") && status === "approved" ? "acknowledged" : status;

export async function createEscalation(
  db: D1Database,
  e: { orderId: number | null; kind: EscalationKind; summary: string; payload: unknown },
  now: Date = new Date(),
): Promise<EscalationRow> {
  const row = await db
    .prepare("INSERT INTO escalations (order_id, kind, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(e.orderId, e.kind, e.summary.slice(0, 1000), JSON.stringify(e.payload ?? null), now.toISOString())
    .first<EscalationRow>();
  if (!row) throw new Error("escalation insert returned no row");
  return row;
}

export async function getEscalation(db: D1Database, id: number): Promise<EscalationRow | null> {
  return db.prepare("SELECT * FROM escalations WHERE id = ?").bind(id).first<EscalationRow>();
}

export async function listEscalations(db: D1Database, opts: { status?: EscalationStatus; limit?: number } = {}): Promise<EscalationRow[]> {
  const limit = opts.limit ?? 50;
  const stmt = opts.status
    ? db.prepare("SELECT * FROM escalations WHERE status = ? ORDER BY id DESC LIMIT ?").bind(opts.status, limit)
    : db.prepare("SELECT * FROM escalations ORDER BY id DESC LIMIT ?").bind(limit);
  return (await stmt.all<EscalationRow>()).results;
}

/** Decides an open escalation; returns null when it was not open (already decided or missing). */
export async function decideEscalation(
  db: D1Database,
  id: number,
  status: "approved" | "rejected",
  note: string | null,
  now: Date = new Date(),
): Promise<EscalationRow | null> {
  return db
    .prepare("UPDATE escalations SET status = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'open' RETURNING *")
    .bind(status, note, now.toISOString(), id)
    .first<EscalationRow>();
}

export async function setTelegramMessageId(db: D1Database, id: number, messageId: number): Promise<void> {
  await db.prepare("UPDATE escalations SET telegram_message_id = ? WHERE id = ?").bind(messageId, id).run();
}

export async function markDelivered(db: D1Database, id: number, now: Date = new Date()): Promise<void> {
  await db.prepare("UPDATE escalations SET delivered_at = ? WHERE id = ?").bind(now.toISOString(), id).run();
}

/** Decided escalations whose agent has not been told yet, newest first. */
export async function listUndelivered(db: D1Database, limit = 20): Promise<EscalationRow[]> {
  return (await db
    .prepare("SELECT * FROM escalations WHERE status != 'open' AND delivered_at IS NULL ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<EscalationRow>()).results;
}

/** Decided escalations, most recently decided first. */
export async function listDecided(db: D1Database, limit = 50): Promise<EscalationRow[]> {
  return (await db
    .prepare("SELECT * FROM escalations WHERE status != 'open' ORDER BY decided_at DESC, id DESC LIMIT ?")
    .bind(limit)
    .all<EscalationRow>()).results;
}
