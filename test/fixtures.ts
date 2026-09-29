import { env } from "cloudflare:test";
import { createOrder } from "../src/db";
import { IntakeSchema } from "../src/intake";
import type { OrderSpec } from "../src/order-spec";

export const completeSpec: OrderSpec = {
  items: [
    { kind: "tshirt", description: "Black tee", method: "screen", quantity: 60, colour: "black", sizes: { S: 10, M: 20, L: 20, XL: 10 }, printAreas: ["front"] },
    { kind: "sticker", description: "Round logo sticker", method: "diecut", quantity: 500, sizeCm: { w: 5, h: 5 } },
  ],
  artwork: [{ fileId: "00000000-0000-4000-8000-000000000001", printable: true, issues: [] }],
};

export function intakeFor(overrides: Record<string, unknown> = {}) {
  return IntakeSchema.parse({
    eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
    deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
    request: "60 black tees with our logo and 500 stickers", ...overrides,
  });
}

export async function newOrderRow(now = new Date("2099-10-01T10:00:00Z")) {
  return createOrder(env.DB, intakeFor(), now);
}

/** A quote row straight in D1, for payment tests that don't need the agent. */
export async function insertQuote(db: D1Database, orderId: number, o: Partial<{ currency: "USD" | "EUR"; priceCents: number; depositCents: number; issuedAt: Date; plnPerUnit: number; itemsKey: string }> = {}) {
  const issuedAt = o.issuedAt ?? new Date();
  const row = await db
    .prepare(
      `INSERT INTO quotes (order_id, currency, price_cents, deposit_cents, cost_pln_grosze, pln_per_unit, usd_per_unit, markup, items_key, issued_at, valid_until)
       VALUES (?, ?, ?, ?, 100000, ?, ?, 0.45, ?, ?, ?) RETURNING id`,
    )
    .bind(orderId, o.currency ?? "USD", o.priceCents ?? 38000, o.depositCents ?? 25750, o.plnPerUnit ?? 4, o.currency === "EUR" ? 1.075 : 1,
      o.itemsKey ?? "test", issuedAt.toISOString(), new Date(issuedAt.getTime() + 48 * 3_600_000).toISOString())
    .first<{ id: number }>();
  return row!.id;
}
