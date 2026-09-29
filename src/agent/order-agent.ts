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

class BudgetExhaustedError extends Error {
  constructor(readonly calls: number) {
    super("per-order model call budget spent");
  }
}

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
  private turnRunning = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS artwork (file_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS previews (file_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`;
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
      text: `New order. Event name (from the host): ${JSON.stringify(intake.eventName)}. Event date (from the host): ${JSON.stringify(intake.eventDate)}. Deliver to (from the host): ${JSON.stringify(intake.deliveryPlace)}. Deliver by (from the host, Warsaw time): ${JSON.stringify(intake.deliverBy)}. Host's first name (from the host): ${JSON.stringify(intake.contactName.split(" ")[0])}.`,
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
    this.addInbox({ kind: "event", text: `Artwork uploaded. fileId: ${meta.fileId}. File name (from the host): ${JSON.stringify(meta.name)}. Type: ${meta.mediaType}. Size: ${meta.size} bytes.` });
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
      busy: this.turnRunning,
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

  /** Tests override this to simulate a bad policy configuration. */
  protected loadTurnPolicy(): ReturnType<typeof loadPolicy> {
    return loadPolicy(this.env as unknown as Record<string, unknown>);
  }

  async processTurn(): Promise<TurnResult | null> {
    if (this.turnRunning) return null;
    this.ensureTables();
    const orderId = this.orderId();
    const pending = this.sql<{ id: number; kind: InboxItem["kind"]; text: string }>`SELECT id, kind, text FROM inbox ORDER BY id`;
    const resume = this.meta("turn_pending") === "1";
    if (pending.length === 0 && !resume) return null;

    const log = (d: Parameters<typeof insertDecision>[1]) => insertDecision(this.env.DB, d);
    const budgetSpent = async (calls: number) => {
      this.addThread("system", "This order has reached the agent's limit. The owner will continue it personally.");
      await log({ orderId, tool: "agent_run", reason: "per-order model call budget spent", input: { calls }, verdict: "none", outcome: "error" });
    };
    const calls = Number(this.meta("model_calls") ?? "0");
    if (calls >= MAX_MODEL_CALLS) {
      await budgetSpent(calls);
      if (pending.length > 0) this.sql`DELETE FROM inbox WHERE id <= ${pending.at(-1)!.id}`;
      this.setMeta("turn_pending", "0");
      return null;
    }

    // Build the policy and handlers before draining, so a bad config loses nothing.
    let handlers: ReturnType<typeof makeHandlers>;
    try {
      const policy = this.loadTurnPolicy();
      handlers = makeHandlers({
        policy,
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
        hasArtwork: async (fileId) => this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM artwork WHERE file_id = ${fileId}`[0].n > 0,
        previewedBytes: async () => this.sql<{ n: number }>`SELECT COALESCE(SUM(bytes), 0) AS n FROM previews`[0].n,
        wasPreviewed: async (fileId) => this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM previews WHERE file_id = ${fileId}`[0].n > 0,
        recordPreview: async (fileId, bytes) => { this.sql`INSERT OR REPLACE INTO previews (file_id, bytes) VALUES (${fileId}, ${bytes})`; },
        logDecision: (d) => log({ orderId, ...d }),
      });
    } catch (err) {
      this.addThread("system", "Something went wrong on our side. Your message is saved and the agent will pick it up.");
      await log({
        orderId, tool: "agent_run", reason: "policy configuration invalid", verdict: "none", outcome: "error",
        input: null, detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    this.turnRunning = true;
    try {
      const store = new SqlR2ConversationStore(this.sql.bind(this), this.env.ARTWORK, `conv/${this.name}/`);
      await this.repairDanglingToolUse(store);
      if (pending.length > 0) {
        // Move the inbox into the conversation as one user message, then clear it.
        await store.append({ role: "user", content: formatInbox(pending.map((p) => ({ kind: p.kind, text: p.text }))) });
        this.sql`DELETE FROM inbox WHERE id <= ${pending.at(-1)!.id}`;
        this.setMeta("turn_pending", "1");
      }

      const real = this.modelOverride ?? createAnthropicModel(this.env);
      const model: ModelClient = {
        create: async (req) => {
          const n = Number(this.meta("model_calls") ?? "0");
          if (n >= MAX_MODEL_CALLS) throw new BudgetExhaustedError(n);
          this.setMeta("model_calls", String(n + 1));
          return real.create(req);
        },
      };
      const result = await runTurn({
        model,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        handlers,
        store,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
      });
      if (result.status === "refused") {
        this.addThread("system", "The agent could not handle the last message. The owner will follow up.");
        await log({ orderId, tool: "agent_run", reason: "model declined the request", input: null, verdict: "none", outcome: "error" });
      } else if (result.status === "tool_limit" || result.status === "truncated") {
        await log({ orderId, tool: "agent_run", reason: `turn ended early: ${result.status}`, input: result, verdict: "none", outcome: "error" });
      }
      return result;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        await budgetSpent(err.calls);
      } else {
        this.addThread("system", "Something went wrong on our side. Your message is saved and the agent will pick it up.");
        await log({
          orderId, tool: "agent_run", reason: "model call failed", input: null, verdict: "none", outcome: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      this.turnRunning = false;
      this.setMeta("turn_pending", "0");
      if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM inbox`[0].n > 0) await this.trigger();
    }
  }
}
