import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getOrderById, setOrderStatus } from "../src/db";
import { acceptQuote, createQuote, expireQuote, getQuote, latestQuote, reopenQuote, type NewQuote } from "../src/quotes";
import { newOrderRow } from "./fixtures";

const q: NewQuote = { currency: "USD", priceCents: 38000, depositCents: 25750, costPln: 1000, plnPerUnit: 4, usdPerUnit: 1, markup: 0.4757, itemsKey: "k1" };

describe("quotes", () => {
  it("creates a quote, supersedes the previous one and marks the order quoted", async () => {
    const { order } = await newOrderRow();
    const now = new Date("2099-10-01T10:00:00Z");
    const first = await createQuote(env.DB, order.id, q, now, 48);
    expect(first).toMatchObject({ order_id: order.id, currency: "USD", price_cents: 38000, deposit_cents: 25750, cost_pln_grosze: 100000, items_key: "k1", status: "open", valid_until: "2099-10-03T10:00:00.000Z" });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("quoted");
    const second = await createQuote(env.DB, order.id, { ...q, priceCents: 37000 }, now, 48);
    expect((await getQuote(env.DB, first.id))?.status).toBe("superseded");
    expect((await latestQuote(env.DB, order.id))?.id).toBe(second.id);
  });

  it("accepts an open quote once, can reopen it, and expires only open quotes", async () => {
    const { order } = await newOrderRow();
    const quote = await createQuote(env.DB, order.id, q, new Date(), 48);
    const accepted = await acceptQuote(env.DB, quote.id, new Date());
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.accepted_at).toBeTruthy();
    expect(await acceptQuote(env.DB, quote.id, new Date())).toBeNull();
    await expireQuote(env.DB, quote.id);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("accepted");
    await reopenQuote(env.DB, quote.id);
    expect(await getQuote(env.DB, quote.id)).toMatchObject({ status: "open", accepted_at: null });
    await expireQuote(env.DB, quote.id);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("expired");
    expect((await latestQuote(env.DB, order.id))?.status).toBe("expired");
  });

  it("refuses to quote an order that is no longer quotable and leaves the open quote alone", async () => {
    const { order } = await newOrderRow();
    const first = await createQuote(env.DB, order.id, q, new Date(), 48);
    expect(await setOrderStatus(env.DB, order.id, ["quoted"], "deposit_pending")).toBe(true);
    await expect(createQuote(env.DB, order.id, q, new Date(), 48)).rejects.toThrow("can no longer be quoted");
    expect((await getQuote(env.DB, first.id))?.status).toBe("open");
  });
});
