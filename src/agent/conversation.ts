import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ConversationStore } from "./loop";

export type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

const BLOB_MIN_CHARS = 4096;
const BLOB_MARK = "r2:";

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rewrites the base64 `source` of image and document blocks only; model-written inputs are never touched. */
async function mapBase64Sources(value: unknown, fn: (data: string) => Promise<string>): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapBase64Sources(v, fn)));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isMedia = obj.type === "image" || obj.type === "document";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const src = v as Record<string, unknown> | null;
      if (isMedia && k === "source" && src && typeof src === "object" && src.type === "base64" && typeof src.data === "string") {
        out[k] = { ...src, data: await fn(src.data) };
      } else {
        out[k] = await mapBase64Sources(v, fn);
      }
    }
    return out;
  }
  return value;
}

/** Append-only conversation in SQLite; large base64 payloads live in R2 so rows stay small. */
export class SqlR2ConversationStore implements ConversationStore {
  constructor(private sql: SqlFn, private bucket: R2Bucket, private prefix: string) {}

  async load(): Promise<BetaMessageParam[]> {
    const rows = this.sql<{ message: string }>`SELECT message FROM conversation ORDER BY id`;
    return Promise.all(
      rows.map(async (r) =>
        (await mapBase64Sources(JSON.parse(r.message), async (data) => {
          if (!data.startsWith(BLOB_MARK + this.prefix)) return data;
          const obj = await this.bucket.get(data.slice(BLOB_MARK.length));
          if (!obj) throw new Error(`conversation blob missing: ${data}`);
          return obj.text();
        })) as BetaMessageParam,
      ),
    );
  }

  async append(message: BetaMessageParam): Promise<void> {
    const slim = await mapBase64Sources(message, async (data) => {
      if (data.length < BLOB_MIN_CHARS) return data;
      const key = `${this.prefix}${await sha256Hex(data)}`;
      if (!(await this.bucket.head(key))) await this.bucket.put(key, data);
      return `${BLOB_MARK}${key}`;
    });
    this.sql`INSERT INTO conversation (message) VALUES (${JSON.stringify(slim)})`;
  }
}

/** Closes an assistant tool_use left without results (crash or refusal) so the API accepts the next call. */
export async function repairDanglingToolUse(sql: SqlFn, store: ConversationStore): Promise<void> {
  const row = sql<{ message: string }>`SELECT message FROM conversation ORDER BY id DESC LIMIT 1`[0];
  if (!row) return;
  const last = JSON.parse(row.message) as { role?: string; content?: unknown };
  if (last.role !== "assistant" || !Array.isArray(last.content)) return;
  const ids = (last.content as { type?: string; id?: string }[]).filter((b) => b?.type === "tool_use" && typeof b.id === "string").map((b) => b.id as string);
  if (ids.length === 0) return;
  await store.append({ role: "user", content: ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: "Interrupted before the result was saved.", is_error: true })) });
}

/** Keeps only the last `keep` inbox turns (a turn starts at a user message that is not a tool_result) so a long-lived agent's context stays bounded. */
export function trimToRecentTurns(sql: SqlFn, keep: number): void {
  const starts = sql<{ id: number; message: string }>`SELECT id, message FROM conversation ORDER BY id`
    .filter((r) => {
      const m = JSON.parse(r.message) as { role?: string; content?: unknown };
      return m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && !m.content.some((b) => (b as { type?: string })?.type === "tool_result")));
    })
    .map((r) => r.id);
  if (starts.length <= keep) return;
  const cut = starts[starts.length - keep];
  sql`DELETE FROM conversation WHERE id < ${cut}`;
}
