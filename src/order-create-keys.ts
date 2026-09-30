/** Idempotent order creation: a retried create with the same key returns the same order for 24 hours. */
export const CREATE_KEY_TTL_MS = 24 * 3_600_000;
/** A reservation with no order this long after it was made belongs to a create that died; it is dropped. */
export const PENDING_STALE_MS = 2 * 60_000;
export const CREATE_KEY = /^[A-Za-z0-9_-]{16,64}$/;

export type KeyLookup =
  | { kind: "none" }
  | { kind: "replay"; token: string }
  | { kind: "conflict" }
  | { kind: "pending" };

/** The order as the client sent it, minus the Turnstile token (single-use, differs on every retry) and the key itself. */
export async function intakeHash(body: Record<string, unknown>): Promise<string> {
  const fields = Object.keys(body)
    .filter((k) => k !== "turnstile" && k !== "idempotencyKey")
    .sort()
    .map((k) => [k, body[k]]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function lookupCreateKey(db: D1Database, key: string, hash: string, now: Date): Promise<KeyLookup> {
  await db.prepare("DELETE FROM order_create_keys WHERE created_at < ?").bind(new Date(now.getTime() - CREATE_KEY_TTL_MS).toISOString()).run();
  await db
    .prepare("DELETE FROM order_create_keys WHERE key = ? AND token IS NULL AND created_at < ?")
    .bind(key, new Date(now.getTime() - PENDING_STALE_MS).toISOString())
    .run();
  const row = await db
    .prepare("SELECT body_hash, token FROM order_create_keys WHERE key = ?")
    .bind(key)
    .first<{ body_hash: string; token: string | null }>();
  if (!row) return { kind: "none" };
  if (row.token === null) return { kind: "pending" };
  if (row.body_hash !== hash) return { kind: "conflict" };
  return { kind: "replay", token: row.token };
}

/** Claims the key for this create; false when another create holds it. */
export async function reserveCreateKey(db: D1Database, key: string, hash: string, now: Date): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO order_create_keys (key, body_hash, created_at) VALUES (?, ?, ?)")
    .bind(key, hash, now.toISOString())
    .run();
  return res.meta.changes === 1;
}

export async function completeCreateKey(db: D1Database, key: string, orderId: number, token: string): Promise<void> {
  await db.prepare("UPDATE order_create_keys SET order_id = ?, token = ? WHERE key = ?").bind(orderId, token, key).run();
}

export async function releaseCreateKey(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM order_create_keys WHERE key = ?").bind(key).run();
}
