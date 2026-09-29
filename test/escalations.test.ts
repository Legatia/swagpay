import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOrder, deleteOrder, listRecentOrders } from "../src/db";
import { createEscalation, decideEscalation, getEscalation, listEscalations, setTelegramMessageId } from "../src/escalations";
import { IntakeSchema } from "../src/intake";

const intake = IntakeSchema.parse({
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees and 500 stickers",
});

describe("escalations", () => {
  it("creates, lists and decides an escalation once", async () => {
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve a banner", payload: { item: "banner" } });
    expect(e).toMatchObject({ order_id: order.id, kind: "approval", status: "open", decision_note: null, telegram_message_id: null });
    expect(JSON.parse(e.payload_json)).toEqual({ item: "banner" });
    expect((await listEscalations(env.DB, { status: "open" })).map((r) => r.id)).toContain(e.id);

    const decided = await decideEscalation(env.DB, e.id, "approved", "fine by me");
    expect(decided).toMatchObject({ id: e.id, status: "approved", decision_note: "fine by me" });
    expect(decided?.decided_at).toBeTruthy();
    expect(await decideEscalation(env.DB, e.id, "rejected", null)).toBeNull();
    expect((await getEscalation(env.DB, e.id))?.status).toBe("approved");
    expect((await listEscalations(env.DB, { status: "open" })).map((r) => r.id)).not.toContain(e.id);
  });

  it("can exist without an order", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "system", summary: "Unmatched transfer", payload: {} });
    expect(e.order_id).toBeNull();
    expect((await getEscalation(env.DB, e.id))?.summary).toBe("Unmatched transfer");
  });

  it("stores the Telegram message id", async () => {
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "system", summary: "x", payload: null });
    await setTelegramMessageId(env.DB, e.id, 777);
    expect((await getEscalation(env.DB, e.id))?.telegram_message_id).toBe(777);
  });

  it("is removed with its order", async () => {
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "agent", summary: "question", payload: {} });
    await deleteOrder(env.DB, order.id);
    expect(await getEscalation(env.DB, e.id)).toBeNull();
  });

  it("lists recent orders newest first", async () => {
    const a = (await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"))).order;
    const b = (await createOrder(env.DB, intake, new Date("2099-01-01T11:00:00Z"))).order;
    const ids = (await listRecentOrders(env.DB, 50)).map((o) => o.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});
