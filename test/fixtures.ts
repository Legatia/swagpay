import { env } from "cloudflare:test";
import { createOrder } from "../src/db";
import { DesignSpecSchema, type DesignSpec } from "../src/design-spec";
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

export const F1 = "11111111-1111-4111-8111-111111111111";
export const F2 = "22222222-2222-4222-8222-222222222222";

export const tshirtDesign = (): DesignSpec => DesignSpecSchema.parse({
  version: 1, product: "tshirt", options: { colour: "black" },
  views: [{ side: "front", printArea: { widthMm: 280, heightMm: 380 }, layers: [
    { type: "image", file: "logo-1", xMm: 40, yMm: 30, widthMm: 200, heightMm: 120, rotationDeg: 0, effectiveDpi: 212 },
    { type: "text", text: "Builders <b>meetup</b>", font: "Big Shoulders Display", weight: 800, colour: "#FFFFFF", sizeMm: 18, xMm: 40, yMm: 170, widthMm: 200, rotationDeg: 0, align: "center" },
  ] }],
  sizes: { S: 10, M: 20, L: 20, XL: 10 }, quantity: 60, sticker: null,
  estimate: { currency: "USD", low: 410, high: 450 },
  files: { "logo-1": { role: "artwork", fileId: F1 }, "mockup-front": { role: "mockup", fileId: F2 } },
});
