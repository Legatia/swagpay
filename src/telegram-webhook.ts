import { getAgentByName } from "agents";
import { getOrderById } from "./db";
import { decideEscalation, getEscalation, listEscalations } from "./escalations";
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
  "/order <number> — order status",
].join("\n");

function sameSecret(given: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Decides an escalation in D1, then tells the order's agent. Returns the reply for the owner. */
export async function decide(env: Env, id: number, status: "approved" | "rejected", note: string | null): Promise<string> {
  const row = await decideEscalation(env.DB, id, status, note);
  if (!row) {
    const existing = await getEscalation(env.DB, id);
    return existing ? `#${id} is already ${existing.status}.` : `#${id} doesn't exist.`;
  }
  const order = row.order_id === null ? null : await getOrderById(env.DB, row.order_id);
  if (order) {
    try {
      const agent = await getAgentByName(env.OrderAgent, order.instance);
      await agent.ownerDecision({ id: row.id, kind: row.kind, summary: row.summary }, status, note);
    } catch (err) {
      console.error("ownerDecision failed", err);
      return `#${id} ${status}, but the agent could not be told: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return `#${id} ${status}.`;
}

async function openList(env: Env): Promise<string> {
  const open = await listEscalations(env.DB, { status: "open", limit: 20 });
  if (open.length === 0) return "No open escalations.";
  return open.map((e) => `#${e.id} · ${e.order_id === null ? "no order" : `order ${e.order_id}`} · ${e.kind} · ${e.summary.slice(0, 120)}`).join("\n");
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
    const text = m ? await decide(env, Number(m[1]), m[2] === "approve" ? "approved" : "rejected", null) : "Unknown button.";
    if (cb.id) {
      try {
        await telegram.answerCallback(cb.id, text);
      } catch (err) {
        console.error("telegram answerCallback failed", err);
      }
    }
    return new Response("ok");
  }

  const words = (update.message?.text ?? "").trim().split(/\s+/);
  const command = (words[0] ?? "").replace(/@\w+$/, "");
  const arg = words[1];
  const note = words.slice(2).join(" ").trim().slice(0, 1000) || null;
  switch (command) {
    case "/open":
      await reply(await openList(env));
      break;
    case "/approve":
    case "/reject": {
      const id = Number(arg);
      await reply(Number.isInteger(id) && id > 0
        ? await decide(env, id, command === "/approve" ? "approved" : "rejected", note)
        : `Usage: ${command} <id> [note]`);
      break;
    }
    case "/order": {
      const n = Number(arg);
      await reply(Number.isInteger(n) && n > 0 ? await orderStatus(env, n) : "Usage: /order <number>");
      break;
    }
    default:
      await reply(HELP);
  }
  return new Response("ok");
}
