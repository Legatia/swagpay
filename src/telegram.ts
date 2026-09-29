import { setTelegramMessageId, type EscalationRow } from "./escalations";

export interface InlineButton {
  text: string;
  data: string;
}

export interface TelegramClient {
  send(chatId: string, text: string, buttons?: InlineButton[][]): Promise<number | null>;
  answerCallback(callbackId: string, text: string): Promise<void>;
}

/** Bot API client. Without a bot token every call is a no-op, so dev and tests never reach Telegram. */
export function createTelegram(token: string | undefined, fetchImpl: typeof fetch = fetch): TelegramClient {
  const call = async (method: string, body: unknown): Promise<unknown> => {
    if (!token) return null;
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result;
  };
  return {
    async send(chatId, text, buttons) {
      const result = (await call("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, 4000),
        ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
      })) as { message_id?: number } | null;
      return result?.message_id ?? null;
    },
    async answerCallback(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 200) });
    },
  };
}

export function escalationText(e: EscalationRow): string {
  return `#${e.id} · ${e.order_id === null ? "No order" : `Order ${e.order_id}`} · ${e.kind}\n${e.summary}`;
}

export function escalationButtons(e: EscalationRow): InlineButton[][] {
  if (e.kind === "system") return [[{ text: "Acknowledge", data: `esc:${e.id}:approve` }]];
  return [[{ text: "Approve", data: `esc:${e.id}:approve` }, { text: "Reject", data: `esc:${e.id}:reject` }]];
}

/** Pushes an escalation to the owner's chat. Failures are logged, never thrown. */
export async function notifyOwner(db: D1Database, telegram: TelegramClient, ownerChatId: string | undefined, e: EscalationRow): Promise<void> {
  if (!ownerChatId) return;
  try {
    const messageId = await telegram.send(ownerChatId, escalationText(e), escalationButtons(e));
    if (messageId !== null) await setTelegramMessageId(db, e.id, messageId);
  } catch (err) {
    console.error("telegram notify failed", err);
  }
}
