// Soft limits read from vars.

/** A numeric var, or `fallback` when it is unset, empty or not a non-negative number. */
export function envNumber(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, unknown>)[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envString(env: Env, name: string): string | null {
  const raw = (env as unknown as Record<string, unknown>)[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

let warnedNoSalt = false;

/** A client's key for one day: HMAC-SHA-256(CLIENT_HASH_SALT, ip|day), 32 hex characters. Null without an IP, or without the secret (the limit is off). */
export async function clientKey(env: Env, ip: string | null, day: string): Promise<string | null> {
  const salt = envString(env, "CLIENT_HASH_SALT");
  if (!salt) {
    if (!warnedNoSalt) {
      warnedNoSalt = true;
      console.warn("CLIENT_HASH_SALT is not set: the per-client order limit is off");
    }
    return null;
  }
  if (!ip) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ip}|${day}`)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clientOrdersToday(db: D1Database, client: string, day: string): Promise<number> {
  return (await db.prepare("SELECT n FROM client_orders WHERE day = ? AND client = ?").bind(day, client).first<{ n: number }>())?.n ?? 0;
}

/** Counts one new order for the client today, and drops counts older than two days. */
export async function countClientOrder(db: D1Database, client: string, day: string): Promise<void> {
  const twoDaysBefore = new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("INSERT INTO client_orders (day, client, n) VALUES (?, ?, 1) ON CONFLICT(day, client) DO UPDATE SET n = n + 1").bind(day, client),
    db.prepare("DELETE FROM client_orders WHERE day < ?").bind(twoDaysBefore),
  ]);
}

export const SANDBOX_BUDGET_TEXT = "The sandbox has used today's AI budget. Your order is saved; come back tomorrow.";
const DEFAULT_SANDBOX_DAILY_MODEL_CALLS = 600;

const isSandboxEnv = (env: Env) => (env as unknown as { SANDBOX?: string }).SANDBOX === "1";

/** Sandbox: whether today's model budget (SANDBOX_DAILY_MODEL_CALLS, default 600, UTC day) has room. Production always has. */
export async function sandboxBudgetLeft(env: Env, now: Date = new Date()): Promise<boolean> {
  if (!isSandboxEnv(env)) return true;
  const n = (await env.DB.prepare("SELECT n FROM model_calls_daily WHERE day = ?").bind(now.toISOString().slice(0, 10)).first<{ n: number }>())?.n ?? 0;
  return n < envNumber(env, "SANDBOX_DAILY_MODEL_CALLS", DEFAULT_SANDBOX_DAILY_MODEL_CALLS);
}

/** Sandbox: takes one model call from today's budget; false when it is spent. Production is always true and writes nothing. */
export async function takeModelCall(env: Env, now: Date = new Date()): Promise<boolean> {
  if (!isSandboxEnv(env)) return true;
  const max = envNumber(env, "SANDBOX_DAILY_MODEL_CALLS", DEFAULT_SANDBOX_DAILY_MODEL_CALLS);
  if (max < 1) return false;
  const row = await env.DB
    .prepare("INSERT INTO model_calls_daily (day, n) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?2 RETURNING n")
    .bind(now.toISOString().slice(0, 10), max)
    .first<{ n: number }>();
  return row !== null;
}
