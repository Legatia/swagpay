import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import { addDeliveries, bestDelivery, deliveryLine, type DeliveryRow } from "../src/deliveries";
import { createEscalation } from "../src/escalations";
import { addOffer, deleteOffer, useOffer } from "../src/offers";
import { intakeFor, newOrderRow } from "./fixtures";

const row = (id: number, method: string, cost: number, arrives: string): DeliveryRow =>
  ({ id, offer_id: 1, method, cost_cents: cost, arrives_at: arrives, note: null, created_at: "x" }) as DeliveryRow;

describe("choosing a delivery", () => {
  it("takes the cheapest option that arrives by the date, the earlier one on a tie", () => {
    const opts = [row(1, "same_day", 60, "2099-10-05"), row(2, "pickup", 0, "2099-10-05"), row(3, "courier", 0, "2099-10-03"), row(4, "parcel_locker", 0, "2099-10-09")];
    expect(bestDelivery(opts, "2099-10-08")?.id).toBe(3);
    expect(bestDelivery([row(1, "courier", 25, "2099-10-12"), row(2, "parcel_locker", 15, "2099-10-14")], "2099-10-08")?.id).toBe(1); // all late: the earliest
    expect(bestDelivery([], "2099-10-08")).toBeNull();
  });

  it("tells the host how and when", () => {
    expect(deliveryLine("courier", "2099-10-14")).toBe("Delivery: by courier, arrives 14 Oct.");
    expect(deliveryLine("pickup", "2099-10-13")).toBe("Delivery: pickup at the printer from 13 Oct.");
    expect(deliveryLine("parcel_locker", "2099-10-14")).toBe("Delivery: to a parcel locker, arrives 14 Oct.");
    expect(deliveryLine("same_day", "2099-10-14")).toBe("Delivery: by same-day courier, arrives 14 Oct.");
    expect(deliveryLine("printer_courier", "2099-10-14")).toBe("Delivery: by the printer's courier, arrives 14 Oct.");
  });
});

async function vendor(): Promise<number> {
  return (await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES ('Delivery Print', 'Gdańsk', 'PL', '[\"screen\"]', 'screened', ?, 'x', 'x') RETURNING id")
    .bind(`test:${crypto.randomUUID()}`).first<{ id: number }>())!.id;
}

async function offerWithDeliveries(orderId: number) {
  const offer = await addOffer(env.DB, { orderId, vendorId: await vendor(), currency: "PLN", priceCents: 1500, deliveryCents: 0, otherCents: 0, arrivesAt: "2099-10-05" });
  const [courier, locker] = await addDeliveries(env.DB, offer.id, [
    { method: "courier", costCents: 25, arrivesAt: "2099-10-07" },
    { method: "parcel_locker", costCents: 15, arrivesAt: "2099-10-07", note: "simulated" },
  ]);
  return { offer, courier, locker };
}

describe("using an offer with a delivery", () => {
  it("switches the offer to the chosen option before recording the cost", async () => {
    const { order } = await newOrderRow();
    await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    const { offer, courier } = await offerWithDeliveries(order.id);
    await useOffer(env, offer.id, new Date(), courier.id);
    const after = await env.DB.prepare("SELECT delivery_cents, arrives_at, delivery_method, delivery_id, chosen_at FROM printer_offers WHERE id = ?").bind(offer.id).first();
    expect(after).toMatchObject({ delivery_cents: 25, arrives_at: "2099-10-07", delivery_method: "courier", delivery_id: courier.id });
    expect(after!.chosen_at).not.toBeNull();
  });

  it("refuses a delivery option from another offer and changes nothing", async () => {
    const { order } = await newOrderRow();
    await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    const mine = await offerWithDeliveries(order.id);
    const other = await offerWithDeliveries(order.id);
    expect(await useOffer(env, mine.offer.id, new Date(), other.courier.id)).toBe("That delivery option isn't on this offer.");
    expect(await env.DB.prepare("SELECT delivery_method, chosen_at FROM printer_offers WHERE id = ?").bind(mine.offer.id).first()).toEqual({ delivery_method: null, chosen_at: null });
  });

  it("deletes an unused offer with its delivery options", async () => {
    const { order } = await newOrderRow();
    const { offer } = await offerWithDeliveries(order.id);
    expect(await deleteOffer(env.DB, offer.id)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM offer_deliveries WHERE offer_id = ?").bind(offer.id).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the order API", () => {
  it("adds the delivery only once an offer with one is used", async () => {
    const { order, token } = await newOrderRow();
    await (await getAgentByName(env.OrderAgent, order.instance)).init(order.id, intakeFor());
    const get = async () => (await handleApi(new Request(`https://swagpay.test/api/o/${token}`), env)).json<{ delivery?: unknown }>();
    expect("delivery" in (await get())).toBe(false);
    await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    const { offer, locker } = await offerWithDeliveries(order.id);
    await useOffer(env, offer.id, new Date(), locker.id);
    expect((await get()).delivery).toEqual({ method: "parcel_locker", arrivesAt: "2099-10-07" });
  });
});
