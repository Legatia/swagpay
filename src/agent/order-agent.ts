import { Agent } from "agents";
import { getOrderById, insertDecision, saveOrderSpec } from "../db";
import { createEscalation, type EscalationKind } from "../escalations";
import { ratesFor, refreshRates } from "../fx";
import type { Intake } from "../intake";
import { designSummary, type DesignSpec, type FileRole } from "../design-spec";
import { EMPTY_SPEC, missingInfo, type OrderSpec } from "../order-spec";
import { loadPolicy } from "../policy";
import { formatUnits } from "../money";
import { getPaymentRequest } from "../payments";
import { priceBand, warsawTime } from "../quote-text";
import { createQuote, getQuote, withdrawStaleQuote } from "../quotes";
import { SqlR2ConversationStore, repairDanglingToolUse } from "./conversation";
import { formatInbox, type InboxItem } from "./inbox";
import { runTurn, type ConversationStore, type TurnResult } from "./loop";
import { previewsIn } from "./previews";
import { createAnthropicModel, type ModelClient } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { createTelegram, notifyOwner, type TelegramClient } from "../telegram";
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
  role: FileRole;
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

export type Reminder = { kind: "quote" | "payment"; id: number };

export class OrderAgent extends Agent<Env, OrderState> {
  initialState: OrderState = { orderId: null };
  /** Tests set this to a scripted model; production uses Claude. */
  modelOverride: ModelClient | null = null;
  /** Tests set this to a fake; production uses the Bot API. */
  telegramOverride: TelegramClient | null = null;
  private tablesReady = false;
  private turnRunning = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS artwork (file_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'artwork')`;
    this.sql`CREATE TABLE IF NOT EXISTS previews (file_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS spec (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS escalated (key TEXT PRIMARY KEY, escalation_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open')`;
    this.sql`CREATE TABLE IF NOT EXISTS printer_costs (spec_key TEXT PRIMARY KEY, cost_grosze INTEGER NOT NULL, escalation_id INTEGER NOT NULL, note TEXT, at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS design (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL)`;
    this.tablesReady = true;
  }

  protected telegram(): TelegramClient {
    return this.telegramOverride ?? createTelegram(this.env.TELEGRAM_BOT_TOKEN);
  }

  /** One escalation per key per order; later calls return the existing one and its status. */
  private async escalateOnce(orderId: number, key: string, kind: EscalationKind, summary: string, payload: unknown) {
    const existing = this.sql<{ escalation_id: number; status: "open" | "approved" | "rejected" }>`SELECT escalation_id, status FROM escalated WHERE key = ${key}`[0];
    if (existing) return { id: existing.escalation_id, status: existing.status, created: false };
    const row = await createEscalation(this.env.DB, { orderId, kind, summary, payload });
    this.sql`INSERT INTO escalated (key, escalation_id, status) VALUES (${key}, ${row.id}, 'open')`;
    await notifyOwner(this.env.DB, this.telegram(), this.env.TELEGRAM_OWNER_CHAT_ID, row);
    return { id: row.id, status: "open" as const, created: true };
  }

  /** Tells the owner about the agent's own failure; never throws. */
  private async systemEscalation(orderId: number, reason: string, detail?: string): Promise<void> {
    try {
      await this.escalateOnce(orderId, `system:${reason}`, "system", `Order ${orderId}: ${reason}${detail ? ` (${detail.slice(0, 300)})` : ""}`, {});
    } catch (err) {
      console.error("system escalation failed", err);
    }
  }

  /** Swagpay itself tells the agent something (payments, quote acceptance); optionally shows a line to the host. */
  async pushEvent(text: string, threadNote?: string): Promise<void> {
    this.ensureTables();
    this.orderId();
    this.addInbox({ kind: "event", text });
    if (threadNote) this.addThread("system", threadNote);
    await this.trigger();
  }

  /** Swagpay asks this order to remind the host later; past times are ignored and repeats deduped. */
  async remindLater(at: string, reminder: Reminder): Promise<void> {
    this.ensureTables();
    this.orderId();
    const when = new Date(at);
    if (!(when.getTime() > Date.now())) return;
    await this.schedule(when, "remind", reminder, { idempotent: true });
  }

  /** Schedule callback: nudge the agent only while the quote is open or the request unpaid. */
  async remind(reminder: Reminder): Promise<void> {
    this.ensureTables();
    this.orderId();
    let text: string | null = null;
    if (reminder.kind === "quote") {
      const q = await getQuote(this.env.DB, reminder.id);
      if (q && q.status === "open") text = `Reminder: quote #${q.id} expires at ${warsawTime(new Date(q.valid_until))} (Warsaw time) and hasn't been accepted. Send the host one short reminder unless you already reminded them today.`;
    } else {
      const r = await getPaymentRequest(this.env.DB, reminder.id);
      if (r && r.status === "open") text = `Reminder: ${r.stage} request #${r.id} still has ${formatUnits(r.amount_units - r.paid_units)} ${r.token} due by ${warsawTime(new Date(r.due_by))} (Warsaw time). Send the host one short reminder unless you already reminded them today.`;
    }
    if (!text) return;
    this.addInbox({ kind: "event", text });
    await this.trigger();
  }

  /** The owner answered a cost request; store the cost for the items it was asked for and wake the agent. */
  async setPrinterCost(escalationId: number, costPln: number, note: string | null): Promise<void> {
    this.ensureTables();
    this.orderId();
    const row = this.sql<{ key: string }>`SELECT key FROM escalated WHERE escalation_id = ${escalationId}`[0];
    if (!row || !row.key.startsWith("cost:")) throw new Error(`#${escalationId} is not a cost request for this order`);
    const grosze = Math.round(costPln * 100);
    this.sql`INSERT OR REPLACE INTO printer_costs (spec_key, cost_grosze, escalation_id, note, at) VALUES (${row.key.slice(5)}, ${grosze}, ${escalationId}, ${note}, ${new Date().toISOString()})`;
    this.sql`UPDATE escalated SET status = 'approved' WHERE escalation_id = ${escalationId}`;
    let band = "";
    try {
      const policy = this.loadTurnPolicy();
      const parts: string[] = [];
      for (const c of ["USD", "EUR"] as const) {
        const r = await ratesFor(this.env.DB, c);
        if (r) {
          const { lo, hi } = priceBand(grosze / 100, r.plnPerUnit, policy);
          parts.push(`${lo.toFixed(2)}–${hi.toFixed(2)} ${c}`);
        }
      }
      if (parts.length) band = ` At today's rates the allowed price is ${parts.join(" or ")}.`;
    } catch (err) {
      console.error("price band unavailable", err);
    }
    const notePart = note ? ` Owner's note: ${JSON.stringify(note)}.` : "";
    this.addInbox({ kind: "event", text: `Printer cost from the owner (escalation #${escalationId}): ${(grosze / 100).toFixed(2)} PLN gross, delivery included.${notePart}${band} You can now send the quote with send_quote.` });
    await this.trigger();
  }

  async ownerDecision(e: { id: number; kind: EscalationKind; summary: string }, decision: "approved" | "rejected", note: string | null): Promise<void> {
    this.ensureTables();
    this.orderId();
    if (e.kind === "system" || e.kind === "payment") {
      // An acknowledgement only re-arms the notice; it costs no model call.
      this.sql`DELETE FROM escalated WHERE escalation_id = ${e.id}`;
      return;
    }
    this.sql`UPDATE escalated SET status = ${decision} WHERE escalation_id = ${e.id}`;
    const notePart = note ? ` Note from the owner: ${JSON.stringify(note)}.` : "";
    this.addInbox({ kind: "event", text: `Owner decision on escalation #${e.id} (summary: ${JSON.stringify(e.summary)}): ${decision}.${notePart}` });
    await this.trigger();
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
      text: `New order. Event name (from the host): ${JSON.stringify(intake.eventName)}. Event date (from the host): ${JSON.stringify(intake.eventDate)}. Deliver to (from the host): ${JSON.stringify(intake.deliveryPlace)}. Deliver by (from the host, Warsaw time): ${JSON.stringify(intake.deliverBy)}. Host's first name (from the host): ${JSON.stringify(intake.contactName.split(" ")[0])}.${intake.designPending ? " The host is designing in the Swagpay editor: the first message was written by the editor, and a design event will follow. Wait for the design before asking about items, unless the host sends another message." : ""}`,
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

  /** The latest design from the editor; the agent turns it into items with update_order. */
  async setDesign(design: DesignSpec): Promise<void> {
    this.ensureTables();
    this.orderId();
    this.sql`INSERT OR REPLACE INTO design (id, json, at) VALUES (1, ${JSON.stringify(design)}, ${new Date().toISOString()})`;
    this.addInbox({ kind: "event", text: designSummary(design) });
    this.addThread("system", "Design received from the editor.");
    await this.trigger();
  }

  async addArtwork(meta: ArtworkMeta): Promise<void> {
    this.ensureTables();
    this.orderId();
    this.sql`INSERT INTO artwork (file_id, name, media_type, size, r2_key, at, role) VALUES (${meta.fileId}, ${meta.name}, ${meta.mediaType}, ${meta.size}, ${meta.key}, ${meta.at}, ${meta.role})`;
    this.addInbox({ kind: "event", text: `Artwork uploaded. fileId: ${meta.fileId}. File name (from the host): ${JSON.stringify(meta.name)}. Type: ${meta.mediaType}. Size: ${meta.size} bytes. Role: ${meta.role}.` });
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
      artwork: this.sql<{ file_id: string; name: string; media_type: string; size: number; r2_key: string; at: string; role: ArtworkMeta["role"] }>`SELECT * FROM artwork ORDER BY at`
        .map((r) => ({ fileId: r.file_id, name: r.name, mediaType: r.media_type, size: r.size, key: r.r2_key, role: r.role, at: r.at })),
      busy: this.turnRunning,
    };
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
      await this.systemEscalation(orderId, "per-order model call budget spent");
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
          // D1 refuses once a quote was accepted, so the Durable Object copy never runs ahead of it.
          await saveOrderSpec(this.env.DB, orderId, spec);
          this.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(spec)})`;
        },
        withdrawStaleQuote: async (key) => {
          const n = await withdrawStaleQuote(this.env.DB, orderId, key);
          if (n !== null) this.addThread("system", `Quote #${n} was withdrawn because the order changed. A new price will follow.`);
          return n;
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
        logDecision: (d) => log({ orderId, ...d }),
        escalateOnce: (key, kind, summary, payload) => this.escalateOnce(orderId, key, kind, summary, payload),
        orderSummary: async () => {
          const row = await getOrderById(this.env.DB, orderId);
          if (!row) throw new Error("order row missing");
          return { number: row.id, status: row.status, deliverBy: new Date(row.deliver_by), deliveryPlace: row.delivery_place };
        },
        printerCost: async (key) => {
          const row = this.sql<{ cost_grosze: number }>`SELECT cost_grosze FROM printer_costs WHERE spec_key = ${key}`[0];
          return row ? row.cost_grosze / 100 : null;
        },
        rates: async (currency) => {
          const now = new Date();
          const cached = await ratesFor(this.env.DB, currency, now);
          if (cached) return cached;
          try {
            await refreshRates(this.env.DB);
          } catch (err) {
            console.error("rate refresh failed", err);
            return null;
          }
          return ratesFor(this.env.DB, currency, new Date());
        },
        issueQuote: async (q, validUntil) => {
          const quote = await createQuote(this.env.DB, orderId, q, new Date(), validUntil);
          await this.remindLater(new Date(Date.parse(quote.valid_until) - 12 * 3_600_000).toISOString(), { kind: "quote", id: quote.id });
          return quote;
        },
        now: () => new Date(),
      });
    } catch (err) {
      this.addThread("system", "Something went wrong on our side. Your message is saved and the agent will pick it up.");
      await log({
        orderId, tool: "agent_run", reason: "policy configuration invalid", verdict: "none", outcome: "error",
        input: null, detail: err instanceof Error ? err.message : String(err),
      });
      await this.systemEscalation(orderId, "policy configuration invalid", err instanceof Error ? err.message : String(err));
      return null;
    }

    this.turnRunning = true;
    try {
      const store = new SqlR2ConversationStore(this.sql.bind(this), this.env.ARTWORK, `conv/${this.name}/`);
      // A preview counts only once the message holding it is saved.
      const tracked: ConversationStore = {
        load: () => store.load(),
        append: async (message) => {
          await store.append(message);
          for (const p of previewsIn(message)) {
            this.sql`INSERT OR REPLACE INTO previews (file_id, bytes) VALUES (${p.fileId}, ${p.bytes})`;
          }
        },
      };
      await repairDanglingToolUse(this.sql.bind(this), store);
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
        store: tracked,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
      });
      if (result.status === "refused") {
        this.addThread("system", "The agent could not handle the last message. The owner will follow up.");
        await log({ orderId, tool: "agent_run", reason: "model declined the request", input: null, verdict: "none", outcome: "error" });
        await this.systemEscalation(orderId, "model declined the request");
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
        await this.systemEscalation(orderId, "model call failed", err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      this.turnRunning = false;
      this.setMeta("turn_pending", "0");
      if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM inbox`[0].n > 0) await this.trigger();
    }
  }
}
