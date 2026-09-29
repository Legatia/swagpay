import type { Intake } from "./intake";
import type { OrderSpec } from "./order-spec";
import { hashToken, newInstanceName, newToken } from "./ids";
import { warsawLocalToUtc } from "./time";

export interface OrderRow {
  id: number;
  instance: string;
  status: string;
  event_name: string;
  event_date: string;
  deliver_by: string;
  delivery_place: string;
  contact_name: string;
  contact_email: string;
  spec_json: string | null;
  created_at: string;
}

const ORDER_COLUMNS =
  "id, instance, status, event_name, event_date, deliver_by, delivery_place, contact_name, contact_email, spec_json, created_at";

export async function createOrder(db: D1Database, intake: Intake, now: Date): Promise<{ order: OrderRow; token: string }> {
  const token = newToken();
  const order = await db
    .prepare(
      `INSERT INTO orders (instance, token_hash, event_name, event_date, deliver_by, delivery_place, contact_name, contact_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ORDER_COLUMNS}`,
    )
    .bind(
      newInstanceName(),
      await hashToken(token),
      intake.eventName,
      intake.eventDate,
      warsawLocalToUtc(intake.deliverBy).toISOString(),
      intake.deliveryPlace,
      intake.contactName,
      intake.contactEmail,
      now.toISOString(),
    )
    .first<OrderRow>();
  if (!order) throw new Error("order insert returned no row");
  return { order, token };
}

export async function getOrderByToken(db: D1Database, token: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE token_hash = ?`).bind(await hashToken(token)).first<OrderRow>();
}

export async function getOrderById(db: D1Database, id: number): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).bind(id).first<OrderRow>();
}

export async function saveOrderSpec(db: D1Database, id: number, spec: OrderSpec): Promise<void> {
  await db.prepare("UPDATE orders SET spec_json = ? WHERE id = ?").bind(JSON.stringify(spec), id).run();
}

export async function countOrdersSince(db: D1Database, since: Date): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?").bind(since.toISOString()).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface NewDecision {
  orderId: number;
  tool: string;
  reason: string;
  input: unknown;
  verdict: "allow" | "block" | "escalate" | "none";
  outcome: "done" | "blocked" | "escalated" | "error";
  detail?: string;
}

export interface DecisionRow {
  id: number;
  order_id: number;
  tool: string;
  reason: string;
  input_json: string;
  verdict: string;
  outcome: string;
  detail: string | null;
  created_at: string;
}

export async function insertDecision(db: D1Database, d: NewDecision, now: Date = new Date()): Promise<void> {
  await db
    .prepare(
      "INSERT INTO decisions (order_id, tool, reason, input_json, verdict, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(d.orderId, d.tool, d.reason, JSON.stringify(d.input ?? null), d.verdict, d.outcome, d.detail ?? null, now.toISOString())
    .run();
}

export async function listDecisions(db: D1Database, orderId: number): Promise<DecisionRow[]> {
  const { results } = await db.prepare("SELECT * FROM decisions WHERE order_id = ? ORDER BY id").bind(orderId).all<DecisionRow>();
  return results;
}

export async function deleteOrder(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM escalations WHERE order_id = ?").bind(id),
    db.prepare("DELETE FROM decisions WHERE order_id = ?").bind(id),
    db.prepare("DELETE FROM orders WHERE id = ?").bind(id),
  ]);
}

export async function listRecentOrders(db: D1Database, limit: number): Promise<OrderRow[]> {
  return (await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders ORDER BY id DESC LIMIT ?`).bind(limit).all<OrderRow>()).results;
}

/** Moves an order to `to` only from one of the `from` states. Returns whether it moved. */
export async function setOrderStatus(db: D1Database, id: number, from: string[], to: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE orders SET status = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
    .bind(to, id, ...from)
    .run();
  return res.meta.changes === 1;
}
