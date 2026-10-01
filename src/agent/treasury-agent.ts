import { isSandbox } from "../sandbox/config";
import { Agent } from "agents";
import { createRpc, type RpcClient } from "../arc";
import { createEscalation } from "../escalations";
import { formatUnits, isAddress } from "../money";
import { createTelegram, notifyOwner, type TelegramClient } from "../telegram";
import {
  getObligation, insertObligation, insertTreasuryDecision, latestPayoutId, listObligations, loadTreasuryPolicy, orderMargin, payoutsLast24h, queuePayout,
  queuedUnits, setObligationNote, setObligationStatus, staleQueuedPayouts, unsweptClosedOrders, vendorObligations, type TreasuryPolicy,
} from "../treasury";
import { SqlR2ConversationStore, repairDanglingToolUse, trimToRecentTurns } from "./conversation";
import { formatInbox, type InboxItem } from "./inbox";
import { runTurn, type TurnResult } from "./loop";
import { createModel, type ModelClient } from "./model";
import { TREASURY_PROMPT } from "./treasury-prompt";
import { TREASURY_TOOLS, makeTreasuryHandlers } from "./treasury-tools";
import { getVendor } from "../vendors";

export const TREASURY_NAME = "treasury";
export const MAX_TREASURY_CALLS_PER_DAY = 60;
export const MAX_TREASURY_TOOL_CALLS = 8;
export const KEEP_TREASURY_TURNS = 5;
const SNAPSHOT_OBLIGATIONS = 30;

export class TreasuryAgent extends Agent<Env, Record<string, never>> {
  initialState: Record<string, never> = {};
  /** Tests set these; production uses Claude, the Bot API and the Arc RPC. */
  modelOverride: ModelClient | null = null;
  telegramOverride: TelegramClient | null = null;
  rpcOverride: RpcClient | null = null;
  private tablesReady = false;
  private turnRunning = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS escalated (key TEXT PRIMARY KEY, escalation_id INTEGER NOT NULL)`;
    this.tablesReady = true;
  }

  private meta(key: string): string | null {
    return this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES (${key}, ${value})`;
  }

  private callsToday(): number {
    return this.meta("calls_day") === new Date().toISOString().slice(0, 10) ? Number(this.meta("calls") ?? "0") : 0;
  }

  /** Swagpay tells the treasury something happened; a turn follows. */
  async notify(text: string): Promise<void> {
    this.ensureTables();
    this.sql`INSERT INTO inbox (kind, text) VALUES ('event', ${text})`;
    await this.trigger();
  }

  /** The owner decided one of the treasury's escalations: re-arm its key, so the same question can be asked again, and tell the agent. */
  async ownerDecision(e: { id: number; summary: string }, decision: "approved" | "rejected", note: string | null): Promise<void> {
    this.ensureTables();
    this.sql`DELETE FROM escalated WHERE escalation_id = ${e.id}`;
    await this.notify(`Owner decision on escalation #${e.id} (summary: ${JSON.stringify(e.summary)}): ${decision}.${note ? ` Note from the owner: ${JSON.stringify(note)}.` : ""}`);
  }

  /** Scheduled by hold_obligation. */
  async recheck(payload: { obligationId: number }): Promise<void> {
    await this.notify(`Recheck obligation #${payload.obligationId}: you held it earlier.`);
  }

  private async trigger(): Promise<void> {
    if (this.env.AGENT_AUTORUN === "1") await this.queue("processTurn", null, { id: "turn" });
  }

  protected telegram(): TelegramClient {
    // The sandbox never messages the owner, not even for work queued before it was switched on.
    if (isSandbox(this.env)) return { async send() { return null; }, async answerCallback() {} };
    return this.telegramOverride ?? createTelegram(this.env.TELEGRAM_BOT_TOKEN);
  }

  /** USDC units in the agent wallet, or null when it can't be read. */
  private async walletUnits(): Promise<number | null> {
    if (!isAddress(this.env.RECEIVING_ADDRESS)) return null;
    try {
      const rpc = this.rpcOverride ?? createRpc([this.env.ARC_RPC_URL, this.env.ARC_RPC_FALLBACK_URL].filter((u) => u));
      return rpc.erc20Balance ? await rpc.erc20Balance(this.env.USDC_ADDRESS, this.env.RECEIVING_ADDRESS) : null;
    } catch (err) {
      console.error("treasury balance read failed", err);
      return null;
    }
  }

  private async escalateOnce(key: string, e: { orderId: number | null; kind: "approval" | "agent" | "system"; summary: string; payload: unknown }): Promise<{ id: number; created: boolean }> {
    const existing = this.sql<{ escalation_id: number }>`SELECT escalation_id FROM escalated WHERE key = ${key}`[0];
    if (existing) return { id: existing.escalation_id, created: false };
    const row = await createEscalation(this.env.DB, e);
    this.sql`INSERT INTO escalated (key, escalation_id) VALUES (${key}, ${row.id})`;
    await notifyOwner(this.env.DB, this.telegram(), this.env.TELEGRAM_OWNER_CHAT_ID, row);
    return { id: row.id, created: true };
  }

  private async snapshot(policy: TreasuryPolicy): Promise<string> {
    const now = new Date();
    // Settled (and cancelled) obligations are done: they are not listed.
    const [balance, queued, used, open, unswept, stale] = await Promise.all([
      this.walletUnits(), queuedUnits(this.env.DB), payoutsLast24h(this.env.DB, now),
      listObligations(this.env.DB, ["open", "approved", "failed", "escalated", "queued", "waiting"], 200),
      unsweptClosedOrders(this.env.DB), staleQueuedPayouts(this.env.DB, now),
    ]);
    // Oldest first from the ledger: show the newest, so stuck ones don't push new ones out.
    const shown = open.slice(-SNAPSHOT_OBLIGATIONS);
    const hidden = open.length - shown.length;
    const lines = [
      `Treasury snapshot: wallet ${balance === null ? "unknown" : formatUnits(balance)} USDC; queued payouts ${formatUnits(queued)} USDC; paid out in the last 24 hours ${formatUnits(used)} of the ${formatUnits(policy.dailyUnits)} USDC budget; per-payout limit ${formatUnits(policy.perTxUnits)} USDC; reserve share ${policy.reserveMinBps}–${policy.reserveMaxBps} bps.`,
      open.length ? "Obligations:" : "No open obligations.",
      ...(hidden > 0 ? [`(${hidden} older obligations not shown)`] : []),
      ...shown.map((o) => {
        const to = o.vendor_id !== null ? `printer #${o.vendor_id}` : o.kind === "refund" ? "the payer's address" : o.destination;
        return `- #${o.id} ${o.kind}${o.order_id !== null ? ` order ${o.order_id}` : ""}: ${formatUnits(o.amount_units)} ${o.token} to ${o.chain} ${to}, ${o.status}${o.status === "waiting" ? " (due after printing)" : ""}${o.approved_by ? ` (approved by ${o.approved_by})` : ""}${o.note ? ` — note: ${o.note}` : ""}`;
      }),
      ...(unswept.length ? [`Closed orders not yet swept: ${unswept.map((id) => `#${id}`).join(", ")}`] : []),
      ...(stale.length ? [`Payouts queued over 2 hours: ${stale.map((p) => `#${p.id} (${Math.floor((now.getTime() - Date.parse(p.created_at)) / 3_600_000)} h)`).join(", ")}`] : []),
    ];
    return lines.join("\n");
  }

  async processTurn(): Promise<TurnResult | null> {
    if (this.turnRunning) return null;
    this.ensureTables();
    const pending = this.sql<{ id: number; kind: InboxItem["kind"]; text: string }>`SELECT id, kind, text FROM inbox ORDER BY id`;
    const resume = this.meta("turn_pending") === "1";
    if (pending.length === 0 && !resume) return null;
    const day = new Date().toISOString().slice(0, 10);
    const log = (d: Parameters<typeof insertTreasuryDecision>[1]) => insertTreasuryDecision(this.env.DB, d);

    if (this.callsToday() >= MAX_TREASURY_CALLS_PER_DAY) {
      // Keep the inbox: tomorrow's first turn picks it up.
      await log({ orderId: null, tool: "agent_run", reason: "daily model call budget spent", input: { day }, verdict: "none", outcome: "error" });
      await this.escalateOnce(`system:budget:${day}`, { orderId: null, kind: "system", summary: "The treasury agent spent today's model call budget; it resumes tomorrow.", payload: {} });
      return null;
    }

    let policy: TreasuryPolicy;
    let handlers: ReturnType<typeof makeTreasuryHandlers>;
    try {
      policy = loadTreasuryPolicy(this.env as unknown as Record<string, unknown>);
      const p = policy;
      handlers = makeTreasuryHandlers({
        policy: p,
        getObligation: (id) => getObligation(this.env.DB, id),
        getVendor: (id) => getVendor(this.env.DB, id),
        vendorObligations: (orderId) => vendorObligations(this.env.DB, orderId),
        latestPayoutId: (obligationId) => latestPayoutId(this.env.DB, obligationId),
        walletUnits: () => this.walletUnits(),
        payoutsLast24h: () => payoutsLast24h(this.env.DB),
        queuedUnits: () => queuedUnits(this.env.DB),
        queuePayout: (ob) => queuePayout(this.env.DB, ob),
        holdObligation: async (id, hours, note) => {
          await setObligationNote(this.env.DB, id, `held: ${note}`);
          await this.schedule(new Date(Date.now() + hours * 3_600_000), "recheck", { obligationId: id });
        },
        orderMargin: (orderId) => orderMargin(this.env.DB, orderId),
        createReserve: (orderId, units, token) => insertObligation(this.env.DB, {
          orderId, kind: "reserve", token, amountUnits: units, destination: p.reserveAddress ?? "", chain: "ARC", dueAt: new Date(), sourceRef: `reserve:order:${orderId}`,
        }),
        // "approved": an owner-approved obligation whose printer moved goes back to the owner.
        markEscalated: async (id) => { await setObligationStatus(this.env.DB, id, ["open", "approved"], "escalated"); },
        escalateOnce: (key, e) => this.escalateOnce(key, e),
        logDecision: async (d) => {
          const input = d.input as { orderId?: unknown; obligationId?: unknown } | null;
          let orderId: number | null = typeof input?.orderId === "number" ? input.orderId : null;
          if (orderId === null && typeof input?.obligationId === "number") orderId = (await getObligation(this.env.DB, input.obligationId))?.order_id ?? null;
          await log({ ...d, orderId });
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await log({ orderId: null, tool: "agent_run", reason: "treasury configuration invalid", input: null, verdict: "none", outcome: "error", detail });
      await this.escalateOnce(`system:config:${day}`, { orderId: null, kind: "system", summary: `Treasury configuration is invalid: ${detail.slice(0, 200)}`, payload: {} });
      return null;
    }

    this.turnRunning = true;
    let failed = false;
    try {
      const store = new SqlR2ConversationStore(this.sql.bind(this), this.env.ARTWORK, `conv/${this.name}/`);
      await repairDanglingToolUse(this.sql.bind(this), store);
      trimToRecentTurns(this.sql.bind(this), KEEP_TREASURY_TURNS);
      if (pending.length > 0) {
        const items = [...pending.map((p) => ({ kind: p.kind, text: p.text })), { kind: "event" as const, text: await this.snapshot(policy) }];
        await store.append({ role: "user", content: formatInbox(items) });
        this.sql`DELETE FROM inbox WHERE id <= ${pending.at(-1)!.id}`;
        this.setMeta("turn_pending", "1");
      }
      const real = this.modelOverride ?? createModel(this.env);
      const model: ModelClient = {
        create: async (req) => {
          const n = this.callsToday();
          if (n >= MAX_TREASURY_CALLS_PER_DAY) throw new Error("daily model call budget spent");
          this.setMeta("calls_day", new Date().toISOString().slice(0, 10));
          this.setMeta("calls", String(n + 1));
          return real.create(req);
        },
      };
      const result = await runTurn({ model, system: TREASURY_PROMPT, tools: TREASURY_TOOLS, handlers, store, maxToolCalls: MAX_TREASURY_TOOL_CALLS });
      if (result.status === "refused") {
        await log({ orderId: null, tool: "agent_run", reason: "model declined the request", input: null, verdict: "none", outcome: "error" });
        await this.escalateOnce(`system:refused:${day}`, { orderId: null, kind: "system", summary: "The treasury agent's model declined a request.", payload: {} });
      } else if (result.status === "tool_limit" || result.status === "truncated") {
        await log({ orderId: null, tool: "agent_run", reason: `turn ended early: ${result.status}`, input: result, verdict: "none", outcome: "error" });
      }
      return result;
    } catch (err) {
      failed = true;
      const detail = err instanceof Error ? err.message : String(err);
      await log({ orderId: null, tool: "agent_run", reason: "treasury turn failed", input: null, verdict: "none", outcome: "error", detail });
      await this.escalateOnce(`system:turn:${day}`, { orderId: null, kind: "system", summary: `The treasury agent's turn failed: ${detail.slice(0, 200)}`, payload: {} });
      return null;
    } finally {
      this.turnRunning = false;
      this.setMeta("turn_pending", "0");
      // A failed turn is retried by the next notify or the daily cron, not in a loop.
      if (!failed && this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM inbox`[0].n > 0) await this.trigger();
    }
  }
}
