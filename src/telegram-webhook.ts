import { getAgentByName } from "agents";
import { getOrderById, setOrderStatus } from "./db";
import { decideEscalation, getEscalation, listEscalations, listUndelivered, markDelivered, statusWord as word, type EscalationRow } from "./escalations";
import { TOKEN_FOR, formatUnits } from "./money";
import { createPaymentRequest } from "./payments";
import { warsawTime } from "./quote-text";
import { acceptedQuote } from "./quotes";
import { createTelegram, type TelegramClient } from "./telegram";

type Update = {
  message?: { chat?: { id?: number }; text?: string };
  callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number } } };
};

export const HELP = [
  "Commands:",
  "/open — open escalations",
  "/approve <id> [note]",
  "/reject <id> [note]",
  "/resend <id> — re-send a decision the agent missed",
  "/cost <id> <PLN> [note] — printer cost for a cost request",
  "/order <number> — order status",
  "/printed <order> — the printer finished; send the balance request",
].join("\n");

function sameSecret(given: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Tells the order's agent about a decided escalation and records that it was told. Never throws. */
async function deliver(env: Env, row: EscalationRow): Promise<boolean> {
  try {
    if (row.order_id !== null) {
      const order = await getOrderById(env.DB, row.order_id);
      if (order) {
        const agent = await getAgentByName(env.OrderAgent, order.instance);
        const cost = row.kind === "cost" && row.status === "approved" ? /^(\d+\.\d{2}) PLN(?:; ([\s\S]*))?$/.exec(row.decision_note ?? "") : null;
        if (cost) await agent.setPrinterCost(row.id, Number(cost[1]), cost[2] ?? null);
        else await agent.ownerDecision({ id: row.id, kind: row.kind, summary: row.summary }, row.status as "approved" | "rejected", row.decision_note);
      }
    }
    await markDelivered(env.DB, row.id);
    return true;
  } catch (err) {
    console.error("decision delivery failed", row.id, err);
    return false;
  }
}

/** Decides an escalation in D1, then tells the order's agent. Returns the reply for the owner (short: button toasts stop at 200 characters). */
export async function decide(env: Env, id: number, status: "approved" | "rejected", note: string | null): Promise<string> {
  if (status === "approved") {
    const pending = await getEscalation(env.DB, id);
    if (pending?.kind === "cost" && pending.status === "open") return `#${id} needs a price: /cost ${id} <PLN gross, delivery included> [note]`;
  }
  const row = await decideEscalation(env.DB, id, status, note);
  if (!row) {
    const existing = await getEscalation(env.DB, id);
    if (!existing) return `#${id} doesn't exist.`;
    const untold = existing.delivered_at === null && existing.order_id !== null ? ` The agent has not been told yet: send /resend ${id}.` : "";
    return `#${id} is already ${word(existing.kind, existing.status)}.${untold}`;
  }
  const w = word(row.kind, row.status);
  return (await deliver(env, row)) ? `#${id} ${w}.` : `#${id} ${w}, but the agent could not be told. Send /resend ${id} to retry.`;
}

/** "1200,50" or "1200.50" → 1200.5; null for anything else or zero. */
export function parsePln(s: string | undefined): number | null {
  if (!s || !/^\d{1,7}([.,]\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return n > 0 ? n : null;
}

export async function giveCost(env: Env, id: number, amount: number, note: string | null): Promise<string> {
  const e = await getEscalation(env.DB, id);
  if (!e) return `#${id} doesn't exist.`;
  if (e.kind !== "cost") return `#${id} is not a cost request.`;
  const row = await decideEscalation(env.DB, id, "approved", `${amount.toFixed(2)} PLN${note ? `; ${note}` : ""}`);
  if (!row) return `#${id} is already ${e.status}.`;
  if (!(await deliver(env, row))) return `#${id} approved, but the agent could not be told. Send /resend ${id} to retry.`;
  return `#${id}: ${amount.toFixed(2)} PLN recorded for order ${row.order_id}.`;
}

/** Re-sends a decided escalation the agent has not been told about. */
export async function resend(env: Env, id: number): Promise<string> {
  const row = await getEscalation(env.DB, id);
  if (!row) return `#${id} doesn't exist.`;
  if (row.status === "open") return `#${id} is still open.`;
  if (row.delivered_at !== null) return `#${id} was already delivered to the agent.`;
  return (await deliver(env, row))
    ? `#${id} re-sent to the agent (${word(row.kind, row.status)}).`
    : `#${id}: the agent could not be told. Try /resend ${id} again later.`;
}

/** The owner reports the printer finished: request the balance (or mark the order paid when nothing is left). */
export async function markPrinted(env: Env, n: number, now: Date = new Date()): Promise<string> {
  const order = await getOrderById(env.DB, n);
  if (!order) return `Order ${n} doesn't exist.`;
  if (order.status !== "deposit_paid") return `Order ${n} is ${order.status}; /printed works once the deposit is paid.`;
  const quote = await acceptedQuote(env.DB, n);
  if (!quote) return `Order ${n} has no accepted quote.`;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const balanceCents = quote.price_cents - quote.deposit_cents;
  if (balanceCents <= 0) {
    if (!(await setOrderStatus(env.DB, n, ["deposit_paid"], "balance_paid"))) return `Order ${n} changed; try again.`;
    await agent.pushEvent('The owner reports the job is printed. Nothing more is due. When the swag arrives, ask the host to press "We received it" on the order page.', "Printing done. Nothing more is due.");
    return `Order ${n}: printed; nothing more is due.`;
  }
  // Due before delivery, but never less than a day away.
  const dueBy = new Date(Math.max(Date.parse(order.deliver_by), now.getTime() + 24 * 3_600_000));
  const request = await createPaymentRequest(env.DB, { orderId: n, quoteId: quote.id, stage: "balance", token: TOKEN_FOR[quote.currency], cents: balanceCents, dueBy }, now);
  if (!(await setOrderStatus(env.DB, n, ["deposit_paid"], "balance_pending"))) return `Order ${n} changed; try again.`;
  const amount = `${formatUnits(request.amount_units)} ${request.token}`;
  await agent.pushEvent(
    `The owner reports the job is printed. Balance request #${request.id}: ${amount} on Arc, due by ${warsawTime(new Date(request.due_by))} (Warsaw time). Tell the host the balance is on the order page.`,
    `Printing done. Balance due: ${amount}.`,
  );
  return `Order ${n}: printed; balance request #${request.id} for ${amount} is on the order page.`;
}

const parseId = (arg: string | undefined): number | null => (arg !== undefined && /^\d{1,9}$/.test(arg) ? Number(arg) : null);

async function openList(env: Env): Promise<string> {
  const [open, undelivered] = await Promise.all([listEscalations(env.DB, { status: "open", limit: 20 }), listUndelivered(env.DB)]);
  if (open.length === 0 && undelivered.length === 0) return "No open escalations.";
  return [
    ...open.map((e) => `#${e.id} · ${e.order_id === null ? "no order" : `order ${e.order_id}`} · ${e.kind} · ${e.summary.slice(0, 120)}`),
    ...undelivered.map((e) => `#${e.id} ${word(e.kind, e.status)} — agent not told yet: /resend ${e.id}`),
  ].join("\n");
}

async function orderStatus(env: Env, n: number): Promise<string> {
  const order = await getOrderById(env.DB, n);
  if (!order) return `Order ${n} doesn't exist.`;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const view = await agent.getView();
  return [
    `Order ${order.id} · ${order.event_name} · ${order.status}`,
    `Deliver by ${order.deliver_by} to ${order.delivery_place}`,
    `Still missing: ${view.missing.join("; ") || "nothing"}`,
    `Messages: ${view.thread.length}`,
  ].join("\n");
}

export async function handleTelegram(request: Request, env: Env, deps: { telegram?: TelegramClient } = {}): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response("not configured", { status: 404 });
  if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return new Response("unauthorized", { status: 401 });
  }
  const owner = env.TELEGRAM_OWNER_CHAT_ID;
  const telegram = deps.telegram ?? createTelegram(env.TELEGRAM_BOT_TOKEN);
  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("ok");
  }
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (!owner || chatId === undefined || String(chatId) !== owner) return new Response("ok");
  const reply = async (text: string) => {
    try {
      await telegram.send(owner, text);
    } catch (err) {
      console.error("telegram reply failed", err);
    }
  };

  const cb = update.callback_query;
  if (cb?.data) {
    const m = /^esc:(\d+):(approve|reject)$/.exec(cb.data);
    let text = "Unknown button.";
    if (m) {
      try {
        text = await decide(env, Number(m[1]), m[2] === "approve" ? "approved" : "rejected", null);
      } catch (err) {
        console.error("telegram button failed", err);
        text = "Something went wrong; try /approve or /reject.";
      }
    }
    if (cb.id) {
      try {
        await telegram.answerCallback(cb.id, text);
      } catch (err) {
        console.error("telegram answerCallback failed", err);
      }
    }
    // The toast disappears; the chat keeps a record of every button press.
    await reply(text);
    return new Response("ok");
  }

  const words = (update.message?.text ?? "").trim().split(/\s+/);
  const command = (words[0] ?? "").replace(/@\w+$/, "");
  const arg = words[1];
  const note = words.slice(2).join(" ").trim().slice(0, 1000) || null;
  try {
    switch (command) {
      case "/open":
        await reply(await openList(env));
        break;
      case "/approve":
      case "/reject": {
        const id = parseId(arg);
        await reply(id !== null && id > 0
          ? await decide(env, id, command === "/approve" ? "approved" : "rejected", note)
          : `Usage: ${command} <id> [note]`);
        break;
      }
      case "/resend": {
        const id = parseId(arg);
        await reply(id !== null && id > 0 ? await resend(env, id) : "Usage: /resend <id>");
        break;
      }
      case "/cost": {
        const id = parseId(arg);
        const amount = parsePln(words[2]);
        if (id === null || id <= 0 || amount === null) {
          await reply("Usage: /cost <id> <PLN gross, delivery included> [note]");
          break;
        }
        // "1 200,50" splits into "1" and "200,50": ask rather than record 1 PLN.
        if (words[3] !== undefined && /^\d{3}([.,]\d{1,2})?$/.test(words[3])) {
          await reply(`Did you mean ${words[2]}${words[3]}? Write the amount without spaces, e.g. /cost ${id} 1200.50`);
          break;
        }
        const costNote = words.slice(3).join(" ").trim().slice(0, 500) || null;
        await reply(await giveCost(env, id, amount, costNote));
        break;
      }
      case "/order": {
        const n = parseId(arg);
        await reply(n !== null && n > 0 ? await orderStatus(env, n) : "Usage: /order <number>");
        break;
      }
      case "/printed": {
        const n = parseId(arg);
        await reply(n !== null && n > 0 ? await markPrinted(env, n) : "Usage: /printed <order number>");
        break;
      }
      default:
        await reply(HELP);
    }
  } catch (err) {
    console.error("telegram command failed", command, err);
    await reply(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Response("ok");
}
