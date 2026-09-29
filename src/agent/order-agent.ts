import { Agent } from "agents";
import { insertDecision, saveOrderSpec } from "../db";
import type { Intake } from "../intake";
import { EMPTY_SPEC, missingInfo, type OrderSpec } from "../order-spec";
import { loadPolicy } from "../policy";
import { SqlR2ConversationStore } from "./conversation";
import { formatInbox, type InboxItem } from "./inbox";
import { runTurn, type TurnResult } from "./loop";
import { createAnthropicModel, type ModelClient } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFINITIONS, makeHandlers, type ArtworkFile } from "./tools";

export const MAX_HOST_MESSAGES = 60;
export const MAX_MODEL_CALLS = 80;
export const MAX_TOOL_CALLS_PER_TURN = 12;
export const MAX_MESSAGE_CHARS = 4000;

export interface OrderState {
  orderId: number | null;
}

export interface ThreadEntry {
  id: number;
  from: "host" | "agent" | "system";
  text: string;
  at: string;
}

export interface ArtworkMeta {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  key: string;
  at: string;
}

export interface OrderView {
  orderId: number;
  spec: OrderSpec;
  missing: string[];
  thread: ThreadEntry[];
  artwork: ArtworkMeta[];
  busy: boolean;
}

export class OrderAgent extends Agent<Env, OrderState> {
  initialState: OrderState = { orderId: null };
  /** Tests set this to a scripted model; production uses Claude. */
  modelOverride: ModelClient | null = null;
  private tablesReady = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS artwork (file_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS spec (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.tablesReady = true;
  }

  private orderId(): number {
    const id = this.state.orderId;
    if (id === null) throw new Error("order not initialised");
    return id;
  }

  private meta(key: string): string | null {
    return this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES (${key}, ${value})`;
  }

  private addThread(from: ThreadEntry["from"], text: string): ThreadEntry {
    const at = new Date().toISOString();
    const row = this.sql<{ id: number }>`INSERT INTO thread (sender, text, at) VALUES (${from}, ${text}, ${at}) RETURNING id`[0];
    return { id: row.id, from, text, at };
  }

  private addInbox(item: InboxItem): void {
    this.sql`INSERT INTO inbox (kind, text) VALUES (${item.kind}, ${item.text})`;
  }

  private async trigger(): Promise<void> {
    if (this.env.AGENT_AUTORUN === "1") await this.queue("processTurn", null, { id: "turn" });
  }

  private readSpec(): OrderSpec {
    const row = this.sql<{ json: string }>`SELECT json FROM spec WHERE id = 1`[0];
    return row ? (JSON.parse(row.json) as OrderSpec) : structuredClone(EMPTY_SPEC);
  }

  async init(orderId: number, intake: Intake): Promise<void> {
    this.ensureTables();
    if (this.state.orderId !== null) return;
    this.setState({ orderId });
    this.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(EMPTY_SPEC)})`;
    this.addInbox({
      kind: "event",
      text: `New order. Event: ${intake.eventName} on ${intake.eventDate}. Deliver to: ${intake.deliveryPlace}, by ${intake.deliverBy} Warsaw time. Host's first name: ${intake.contactName.split(" ")[0]}.`,
    });
    this.addInbox({ kind: "host", text: intake.request });
    this.addThread("host", intake.request);
    await this.trigger();
  }

  async postHostMessage(text: string): Promise<ThreadEntry> {
    this.ensureTables();
    this.orderId();
    if (text.length > MAX_MESSAGE_CHARS) throw new Error("message too long");
    const sent = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM thread WHERE sender = 'host'`[0].n;
    if (sent >= MAX_HOST_MESSAGES) throw new Error("message limit reached");
    this.addInbox({ kind: "host", text });
    const entry = this.addThread("host", text);
    await this.trigger();
    return entry;
  }

  async addArtwork(meta: ArtworkMeta): Promise<void> {
    this.ensureTables();
    this.orderId();
    this.sql`INSERT INTO artwork (file_id, name, media_type, size, r2_key, at) VALUES (${meta.fileId}, ${meta.name}, ${meta.mediaType}, ${meta.size}, ${meta.key}, ${meta.at})`;
    this.addInbox({ kind: "event", text: `Artwork uploaded. fileId: ${meta.fileId}, name: ${meta.name}, type: ${meta.mediaType}, size: ${meta.size} bytes.` });
    this.addThread("system", `File uploaded: ${meta.name}`);
    await this.trigger();
  }

  async getView(): Promise<OrderView> {
    this.ensureTables();
    const spec = this.readSpec();
    return {
      orderId: this.orderId(),
      spec,
      missing: missingInfo(spec),
      thread: this.sql<{ id: number; sender: ThreadEntry["from"]; text: string; at: string }>`SELECT id, sender, text, at FROM thread ORDER BY id`
        .map((r) => ({ id: r.id, from: r.sender, text: r.text, at: r.at })),
      artwork: this.sql<{ file_id: string; name: string; media_type: string; size: number; r2_key: string; at: string }>`SELECT * FROM artwork ORDER BY at`
        .map((r) => ({ fileId: r.file_id, name: r.name, mediaType: r.media_type, size: r.size, key: r.r2_key, at: r.at })),
      busy: this.meta("busy") === "1",
    };
  }

  /** Closes an assistant tool_use left without results (crash or refusal) so the API accepts the next call. */
  private async repairDanglingToolUse(store: SqlR2ConversationStore): Promise<void> {
    const row = this.sql<{ message: string }>`SELECT message FROM conversation ORDER BY id DESC LIMIT 1`[0];
    if (!row) return;
    const last = JSON.parse(row.message) as { role?: string; content?: unknown };
    if (last.role !== "assistant" || !Array.isArray(last.content)) return;
    const ids = (last.content as { type?: string; id?: string }[])
      .filter((b) => b?.type === "tool_use" && typeof b.id === "string")
      .map((b) => b.id as string);
    if (ids.length === 0) return;
    await store.append({
      role: "user",
      content: ids.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Interrupted before the result was saved.",
        is_error: true,
      })),
    });
  }

  async processTurn(): Promise<TurnResult | null> {
    this.ensureTables();
    const orderId = this.orderId();
    const pending = this.sql<{ id: number; kind: InboxItem["kind"]; text: string }>`SELECT id, kind, text FROM inbox ORDER BY id`;
    if (pending.length === 0) return null;

    const log = (d: Parameters<typeof insertDecision>[1]) => insertDecision(this.env.DB, d);
    const calls = Number(this.meta("model_calls") ?? "0");
    if (calls >= MAX_MODEL_CALLS) {
      this.addThread("system", "This order has reached the agent's limit. The owner will continue it personally.");
      await log({ orderId, tool: "agent_run", reason: "per-order model call budget spent", input: { calls }, verdict: "none", outcome: "error" });
      this.sql`DELETE FROM inbox WHERE id <= ${pending.at(-1)!.id}`;
      return null;
    }

    const store = new SqlR2ConversationStore(this.sql.bind(this), this.env.ARTWORK, `conv/${this.name}/`);
    await this.repairDanglingToolUse(store);
    // Move the inbox into the conversation as one user message, then clear it.
    await store.append({ role: "user", content: formatInbox(pending.map((p) => ({ kind: p.kind, text: p.text }))) });
    this.sql`DELETE FROM inbox WHERE id <= ${pending.at(-1)!.id}`;

    const handlers = makeHandlers({
      policy: loadPolicy(this.env as unknown as Record<string, unknown>),
      getSpec: async () => this.readSpec(),
      saveSpec: async (spec) => {
        this.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(spec)})`;
        await saveOrderSpec(this.env.DB, orderId, spec);
      },
      postToHost: async (text) => { this.addThread("agent", text); },
      loadArtwork: async (fileId): Promise<ArtworkFile | null> => {
        const row = this.sql<{ name: string; media_type: string; r2_key: string }>`SELECT name, media_type, r2_key FROM artwork WHERE file_id = ${fileId}`[0];
        if (!row) return null;
        const obj = await this.env.ARTWORK.get(row.r2_key);
        if (!obj) return null;
        return { fileId, name: row.name, mediaType: row.media_type, bytes: new Uint8Array(await obj.arrayBuffer()) };
      },
      logDecision: (d) => log({ orderId, ...d }),
    });

    this.setMeta("busy", "1");
    try {
      const result = await runTurn({
        model: this.modelOverride ?? createAnthropicModel(this.env),
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        handlers,
        store,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
      });
      this.setMeta("model_calls", String(calls + result.modelCalls));
      if (result.status === "refused") {
        this.addThread("system", "The agent could not handle the last message. The owner will follow up.");
        await log({ orderId, tool: "agent_run", reason: "model declined the request", input: null, verdict: "none", outcome: "error" });
      } else if (result.status === "tool_limit" || result.status === "truncated") {
        await log({ orderId, tool: "agent_run", reason: `turn ended early: ${result.status}`, input: result, verdict: "none", outcome: "error" });
      }
      return result;
    } catch (err) {
      this.setMeta("model_calls", String(calls + 1));
      this.addThread("system", "Something went wrong on our side. Your message is saved and the agent will pick it up.");
      await log({
        orderId, tool: "agent_run", reason: "model call failed", input: null, verdict: "none", outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this.setMeta("busy", "0");
    }
  }
}
