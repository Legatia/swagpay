import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/db";
import { createEscalation, getEscalation, type EscalationRow } from "../src/escalations";
import { IntakeSchema } from "../src/intake";
import { createTelegram, escalationButtons, escalationText, notifyOwner, type TelegramClient } from "../src/telegram";

function recorder(result: unknown = { message_id: 5 }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const row = (o: Partial<EscalationRow>): EscalationRow => ({
  id: 7, order_id: 3, kind: "approval", summary: "Approve: banner", payload_json: "{}", status: "open",
  decision_note: null, telegram_message_id: null, created_at: "2099-01-01T00:00:00.000Z", decided_at: null, delivered_at: null, ...o,
});

describe("createTelegram", () => {
  it("sends messages with inline buttons and returns the message id", async () => {
    const { calls, fetchImpl } = recorder();
    const t = createTelegram("TOKEN", fetchImpl);
    expect(await t.send("42", "hello", [[{ text: "Approve", data: "esc:7:approve" }]])).toBe(5);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0].body).toEqual({ chat_id: "42", text: "hello", reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "esc:7:approve" }]] } });
    await t.answerCallback("cb1", "Approved");
    expect(calls[1]).toEqual({ url: "https://api.telegram.org/botTOKEN/answerCallbackQuery", body: { callback_query_id: "cb1", text: "Approved" } });
  });

  it("does nothing without a bot token", async () => {
    const { calls, fetchImpl } = recorder();
    expect(await createTelegram(undefined, fetchImpl).send("42", "hi")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws when Telegram says no", async () => {
    const fetchImpl = (async () => Response.json({ ok: false, description: "chat not found" })) as unknown as typeof fetch;
    await expect(createTelegram("T", fetchImpl).send("1", "x")).rejects.toThrow("chat not found");
  });
});

describe("escalation messages", () => {
  it("formats the text and offers Approve/Reject, or Acknowledge for system notices", () => {
    expect(escalationText(row({}))).toBe("#7 · Order 3 · approval\nApprove: banner");
    expect(escalationText(row({ order_id: null, kind: "system", summary: "Unmatched transfer" }))).toBe("#7 · No order · system\nUnmatched transfer");
    expect(escalationButtons(row({}))).toEqual([[{ text: "Approve", data: "esc:7:approve" }, { text: "Reject", data: "esc:7:reject" }]]);
    expect(escalationButtons(row({ kind: "system" }))).toEqual([[{ text: "Acknowledge", data: "esc:7:approve" }]]);
  });

  it("notifies the owner and stores the message id, and never throws", async () => {
    const { order } = await createOrder(env.DB, IntakeSchema.parse({
      eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
      deliveryPlace: "Kolektyw3", contactName: "Ana", contactEmail: "ana@example.com", request: "60 black tees please",
    }), new Date("2099-01-01T10:00:00Z"));
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: banner", payload: {} });
    const sent: string[] = [];
    const ok: TelegramClient = { async send(_c, text) { sent.push(text); return 99; }, async answerCallback() {} };
    await notifyOwner(env.DB, ok, "42", e);
    expect(sent[0]).toContain(`#${e.id}`);
    expect((await getEscalation(env.DB, e.id))?.telegram_message_id).toBe(99);

    const broken: TelegramClient = { async send() { throw new Error("down"); }, async answerCallback() {} };
    await expect(notifyOwner(env.DB, broken, "42", e)).resolves.toBeUndefined();
    await expect(notifyOwner(env.DB, ok, "", e)).resolves.toBeUndefined();
  });
});
