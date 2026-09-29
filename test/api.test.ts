import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { OrderAgent } from "../src/agent/order-agent";
import { getOrderByToken, saveOrderSpec, setOrderStatus } from "../src/db";
import { EMPTY_SPEC, itemsKey } from "../src/order-spec";
import { acceptQuoteForOrder, createQuote, getQuote } from "../src/quotes";
import { createPaymentRequest } from "../src/payments";
import { handleApi } from "../src/api";
import { completeSpec } from "./fixtures";

const intake = {
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
};
const base = "https://swagpay.test";

async function newOrder(): Promise<string> {
  const res = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify(intake), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json<{ token: string; url: string }>();
  expect(body.url).toBe(`/o/${body.token}`);
  return body.token;
}

describe("API", () => {
  it("creates an order and shows it by token", async () => {
    const token = await newOrder();
    const res = await SELF.fetch(`${base}/api/o/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ order: { eventName: string; deliverBy: string }; view: { thread: Array<{ text: string }> } }>();
    expect(body.order.eventName).toBe("Builders meetup");
    expect(body.order.deliverBy).toBe("2099-10-08T15:00:00.000Z");
    expect(body.view.thread[0].text).toContain("60 black tees");
    expect(JSON.stringify(body)).not.toContain("ana@example.com");
  });

  it("rejects bad intake with the field name", async () => {
    const res = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify({ ...intake, contactEmail: "x" }) });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/^contactEmail/);
    const past = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify({ ...intake, eventDate: "2020-01-01", deliverBy: "2020-01-01T10:00" }) });
    expect(past.status).toBe(400);
    const notJson = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("returns 404 for unknown tokens and routes", async () => {
    expect((await SELF.fetch(`${base}/api/o/${"x".repeat(43)}`)).status).toBe(404);
    expect((await SELF.fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("accepts host messages and rejects empty or oversized ones", async () => {
    const token = await newOrder();
    const ok = await SELF.fetch(`${base}/api/o/${token}/messages`, { method: "POST", body: JSON.stringify({ text: "S 10, M 20, L 20, XL 10" }) });
    expect(ok.status).toBe(201);
    expect((await SELF.fetch(`${base}/api/o/${token}/messages`, { method: "POST", body: JSON.stringify({ text: " " }) })).status).toBe(400);
    expect((await SELF.fetch(`${base}/api/o/${token}/messages`, { method: "POST", body: JSON.stringify({ text: "x".repeat(4001) }) })).status).toBe(400);
  });

  it("stores artwork in R2 and lists it", async () => {
    const token = await newOrder();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "logo.png", { type: "image/png" }));
    const res = await SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { fileId } = await res.json<{ fileId: string }>();
    const view = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{ view: { artwork: Array<{ fileId: string; key: string }> } }>();
    const meta = view.view.artwork.find((a) => a.fileId === fileId)!;
    expect(await env.ARTWORK.head(meta.key)).not.toBeNull();
  });

  it("refuses unsupported and oversized uploads", async () => {
    const token = await newOrder();
    const exe = new FormData();
    exe.append("file", new File([new Uint8Array(4)], "run.exe", { type: "application/x-msdownload" }));
    expect((await SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: exe })).status).toBe(400);
    const big = new FormData();
    big.append("file", new File([new Uint8Array(10_000_001)], "big.png", { type: "image/png" }));
    expect((await SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: big })).status).toBe(413);
  });

  it("stops host messages at the per-order limit", async () => {
    const token = await newOrder();
    const post = () => SELF.fetch(`${base}/api/o/${token}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    for (let i = 0; i < 59; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });

  it("stops uploads at the per-order file limit", async () => {
    const token = await newOrder();
    const upload = () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "logo.png", { type: "image/png" }));
      return SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: form });
    };
    for (let i = 0; i < 10; i++) expect((await upload()).status).toBe(201);
    const res = await upload();
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("up to 10 files");
  });

  it("rejects unsupported methods on an order", async () => {
    const token = await newOrder();
    expect((await SELF.fetch(`${base}/api/o/${token}`, { method: "PUT" })).status).toBe(405);
  });

  it("refuses uploads whose bytes don't match their type, and empty files", async () => {
    const token = await newOrder();
    const disguised = new FormData();
    disguised.append("file", new File([new TextEncoder().encode("%PDF-1.4")], "logo.png", { type: "image/png" }));
    const r1 = await SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: disguised });
    expect(r1.status).toBe(400);
    expect((await r1.json<{ error: string }>()).error).toContain("doesn't match its type");
    const empty = new FormData();
    empty.append("file", new File([new Uint8Array(0)], "logo.png", { type: "image/png" }));
    const r2 = await SELF.fetch(`${base}/api/o/${token}/artwork`, { method: "POST", body: empty });
    expect(r2.status).toBe(400);
    expect((await r2.json<{ error: string }>()).error).toContain("empty");
  });

  async function quotedOrder(issuedAt = new Date(), validUntil = new Date(issuedAt.getTime() + 48 * 3_600_000)) {
    const token = await newOrder();
    const order = (await getOrderByToken(env.DB, token))!;
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?), ('EUR', 4.3, '2099-09-30', ?)")
      .bind(new Date().toISOString(), new Date().toISOString()).run();
    // The order has no saved spec yet, so the quote is for the empty item list.
    const quote = await createQuote(env.DB, order.id, { currency: "USD", priceCents: 38000, depositCents: 25750, costPln: 1000, plnPerUnit: 4, usdPerUnit: 1, markup: 0.4757, itemsKey: await itemsKey(EMPTY_SPEC) }, issuedAt, validUntil);
    return { token, order, quote };
  }
  const accept = (token: string, quoteId: unknown) =>
    SELF.fetch(`${base}/api/o/${token}/quote/accept`, { method: "POST", body: JSON.stringify({ quoteId }) });

  it("accepts a quote once, creates the tagged deposit request and tells the agent", async () => {
    const { token, order, quote } = await quotedOrder();
    const res = await accept(token, quote.id);
    expect(res.status).toBe(201);
    const { requestId } = await res.json<{ requestId: number }>();
    const repeat = await accept(token, quote.id);
    expect(repeat.status).toBe(201);
    expect((await repeat.json<{ requestId: number }>()).requestId).toBe(requestId);
    const view = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{
      order: { status: string }; quote: { status: string; price: string; deposit: string };
      payments: Array<{ id: number; stage: string; token: string; amount: string; due: string; status: string }>;
      payTo: { address: string; network: string; chainId: number };
    }>();
    expect(view.order.status).toBe("deposit_pending");
    expect(view.quote).toMatchObject({ status: "accepted", price: "380.00", deposit: "257.50" });
    expect(view.payments).toHaveLength(1);
    expect(view.payments[0]).toMatchObject({ id: requestId, stage: "deposit", token: "USDC", status: "open" });
    expect(view.payments[0].amount).toMatch(/^257\.50\d{4}$/);
    expect(view.payments[0].due).toBe(view.payments[0].amount);
    expect(view.payTo).toMatchObject({ address: "0x1111111111111111111111111111111111111111", network: "Arc", chainId: 5042 });
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox).toContain(`The host accepted quote #${quote.id}. Deposit request #${requestId}: ${view.payments[0].amount} USDC on Arc.`);
      expect((await agent.getView()).thread.at(-1)).toMatchObject({ from: "system", text: `Quote #${quote.id} accepted. Deposit due: ${view.payments[0].amount} USDC.` });
    });
  });

  it("gives the deposit 48 hours, at most a day past the quote, and never past the deadline", async () => {
    const dueBy = async (requestId: number) =>
      (await env.DB.prepare("SELECT due_by FROM payment_requests WHERE id = ?").bind(requestId).first<{ due_by: string }>())!.due_by;
    const before = Date.now();
    const plain = await quotedOrder();
    const { requestId: a } = await (await accept(plain.token, plain.quote.id)).json<{ requestId: number }>();
    expect(Date.parse(await dueBy(a))).toBeGreaterThanOrEqual(before + 48 * 3_600_000);
    expect(Date.parse(await dueBy(a))).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000);

    const short = await quotedOrder(new Date(), new Date(Date.now() + 2 * 3_600_000));
    const { requestId: b } = await (await accept(short.token, short.quote.id)).json<{ requestId: number }>();
    expect(Date.parse(await dueBy(b))).toBe(Date.parse(short.quote.valid_until) + 24 * 3_600_000);

    const soon = await quotedOrder();
    const deliverBy = new Date(Date.now() + 10 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE orders SET deliver_by = ? WHERE id = ?").bind(deliverBy, soon.order.id).run();
    const { requestId: c } = await (await accept(soon.token, soon.quote.id)).json<{ requestId: number }>();
    expect(await dueBy(c)).toBe(deliverBy);
  });

  it("refuses a quote whose items changed", async () => {
    const { token, order, quote } = await quotedOrder();
    await saveOrderSpec(env.DB, order.id, completeSpec);
    const res = await accept(token, quote.id);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe("The order changed since this quote. The agent will send a new one.");
    expect((await getQuote(env.DB, quote.id))?.status).toBe("superseded");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE quote_id = ?").bind(quote.id).first<{ n: number }>())?.n).toBe(0);
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Quote #${quote.id} no longer matches the order's items; send a new quote.`);
    });
  });

  it("expires a quote that is too old and tells the agent to re-quote", async () => {
    const { token, order, quote } = await quotedOrder(new Date(Date.now() - 49 * 3_600_000));
    const res = await accept(token, quote.id);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("expired");
    expect((await getQuote(env.DB, quote.id))?.status).toBe("expired");
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Quote #${quote.id} expired before the host accepted it`);
    });
  });

  it("refuses to accept while payments are closed or for another order's quote", async () => {
    const { token, quote } = await quotedOrder();
    const other = await quotedOrder();
    expect((await accept(token, other.quote.id)).status).toBe(404);
    expect((await accept(token, "x")).status).toBe(404);
    const closed = ({ ...env, RECEIVING_ADDRESS: "" }) as Env;
    const res = await handleApi(new Request(`${base}/api/o/${token}/quote/accept`, { method: "POST", body: JSON.stringify({ quoteId: quote.id }) }), closed);
    expect(res.status).toBe(503);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("open");
  });

  it("serves pricing inputs for the design editor", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?), ('EUR', 4.3, '2099-09-30', ?)")
      .bind(new Date().toISOString(), new Date().toISOString()).run();
    const res = await SELF.fetch(`${base}/api/pricing`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.json<{ plnPerUnit: { USD: number; EUR: number } | null; fetchedAt: string | null; markupMin: number; markupMax: number; fxBuffer: number; perOrderCapUsd: number }>();
    expect(body).toMatchObject({ plnPerUnit: { USD: 4, EUR: 4.3 }, markupMin: 0.4, markupMax: 0.5, fxBuffer: 0.03, perOrderCapUsd: 1000 });
    expect(body.fetchedAt).toBeTruthy();
  });

  it("stores a payer's transaction hash once", async () => {
    const { token, quote } = await quotedOrder();
    const { requestId } = await (await accept(token, quote.id)).json<{ requestId: number }>();
    const claim = (id: number, txHash: unknown) =>
      SELF.fetch(`${base}/api/o/${token}/payments/${id}/claim`, { method: "POST", body: JSON.stringify({ txHash }) });
    const h = `0x${"ab".repeat(32)}`;
    expect((await claim(requestId, "0x123")).status).toBe(400);
    expect((await claim(requestId + 1000, h)).status).toBe(404);
    expect((await claim(requestId, h)).status).toBe(201);
    const second = await quotedOrder();
    const { requestId: otherId } = await (await accept(second.token, second.quote.id)).json<{ requestId: number }>();
    const taken = await SELF.fetch(`${base}/api/o/${second.token}/payments/${otherId}/claim`, { method: "POST", body: JSON.stringify({ txHash: h }) });
    expect(taken.status).toBe(409);
  });

  it("reopens the quote when the deposit request can't be created", async () => {
    const token = await newOrder();
    const order = (await getOrderByToken(env.DB, token))!;
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?)").bind(new Date().toISOString()).run();
    const quote = await createQuote(env.DB, order.id, { currency: "USD", priceCents: 38000, depositCents: 0, costPln: 1000, plnPerUnit: 4, usdPerUnit: 1, markup: 0.4757, itemsKey: await itemsKey(EMPTY_SPEC) }, new Date(), new Date(Date.now() + 48 * 3_600_000));
    expect((await accept(token, quote.id)).status).toBe(500);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("open");
    expect((await getOrderByToken(env.DB, token))?.status).toBe("quoted");
  });

  it("reuses the deposit request after a half-finished acceptance", async () => {
    const { token, order, quote } = await quotedOrder();
    // As if an earlier call created the request and then failed before answering.
    const earlier = await createPaymentRequest(env.DB, { orderId: order.id, quoteId: quote.id, stage: "deposit", token: "USDC", cents: quote.deposit_cents, dueBy: new Date(Date.now() + 3_600_000) });
    const first = await accept(token, quote.id);
    expect(first.status).toBe(201);
    expect((await first.json<{ requestId: number }>()).requestId).toBe(earlier.id);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("accepted");
    expect((await getOrderByToken(env.DB, token))?.status).toBe("deposit_pending");
    const again = await accept(token, quote.id);
    expect(again.status).toBe(201);
    expect((await again.json<{ requestId: number }>()).requestId).toBe(earlier.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE quote_id = ?").bind(quote.id).first<{ n: number }>())?.n).toBe(1);
  });

  it("does not accept when the order changed between the check and the acceptance", async () => {
    const { token, order, quote } = await quotedOrder();
    // Same items, other details: the key still matches, but the acceptance must see the spec it checked.
    const stale = { ...order, spec_json: JSON.stringify({ ...EMPTY_SPEC, notes: "old" }) };
    await saveOrderSpec(env.DB, order.id, { ...EMPTY_SPEC, notes: "new" });
    expect(await acceptQuoteForOrder(env.DB, quote.id, stale, new Date())).toBe("order_changed");
    expect((await getQuote(env.DB, quote.id))?.status).toBe("open");
    expect((await getOrderByToken(env.DB, token))?.status).toBe("quoted");
    expect((await accept(token, quote.id)).status).toBe(201);
  });

  it("refuses to accept when the order is no longer quoted", async () => {
    const { token, order, quote } = await quotedOrder();
    await setOrderStatus(env.DB, order.id, ["quoted"], "deposit_pending");
    const res = await accept(token, quote.id);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("already has an accepted quote");
  });

  it("expires a quote when the złoty moved past the buffer", async () => {
    const { token, quote } = await quotedOrder();
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 3.7, '2099-09-30', ?)").bind(new Date().toISOString()).run();
    expect((await accept(token, quote.id)).status).toBe(409);
    expect((await getQuote(env.DB, quote.id))?.status).toBe("expired");
  });

  it("serves null rates when they are stale", async () => {
    const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?), ('EUR', 4.3, '2099-09-30', ?)").bind(old, old).run();
    const body = await (await SELF.fetch(`${base}/api/pricing`)).json<{ plnPerUnit: unknown; fetchedAt: unknown; markupMin: number; fxBuffer: number; perOrderCapUsd: number }>();
    expect(body.plnPerUnit).toBeNull();
    expect(body.fetchedAt).toBeNull();
    expect(body).toMatchObject({ markupMin: 0.4, fxBuffer: 0.03, perOrderCapUsd: 1000 });
  });

  it("scopes claims to the order, lowercases hashes, only for open requests and caps them", async () => {
    const a = await quotedOrder();
    const { requestId } = await (await accept(a.token, a.quote.id)).json<{ requestId: number }>();
    const b = await quotedOrder();
    const claim = (token: string, id: number, txHash: string) =>
      SELF.fetch(`${base}/api/o/${token}/payments/${id}/claim`, { method: "POST", body: JSON.stringify({ txHash }) });
    expect((await claim(b.token, requestId, `0x${"cd".repeat(32)}`)).status).toBe(404);
    expect((await claim(a.token, requestId, `0x${"CD".repeat(32)}`)).status).toBe(201);
    expect((await claim(a.token, requestId, `0x${"cd".repeat(32)}`)).status).toBe(201);
    for (const n of ["01", "02", "03", "04"]) expect((await claim(a.token, requestId, `0x${n.repeat(32)}`)).status).toBe(201);
    const sixth = await claim(a.token, requestId, `0x${"06".repeat(32)}`);
    expect(sixth.status).toBe(429);
    await env.DB.prepare("UPDATE payment_requests SET status = 'paid' WHERE id = ?").bind(requestId).run();
    expect((await claim(a.token, requestId, `0x${"05".repeat(32)}`)).status).toBe(409);
  });

  it("caps new orders per day", async () => {
    // MAX_NEW_ORDERS_PER_DAY is 50 in the test config. Fill today's quota directly, then ask for one more.
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      `INSERT INTO orders (instance, token_hash, event_name, event_date, deliver_by, delivery_place, contact_name, contact_email, created_at)
       VALUES (?, ?, 'x', '2099-10-08', '2099-10-08T15:00:00.000Z', 'x', 'x', 'x@example.com', ?)`,
    );
    await env.DB.batch(Array.from({ length: 50 }, () => insert.bind(`cap-${crypto.randomUUID()}`, crypto.randomUUID(), now)));
    const res = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify(intake) });
    expect(res.status).toBe(429);
  });
});
