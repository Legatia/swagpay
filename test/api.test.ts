import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const intake = {
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
};
const base = "https://swagpay.test";

async function newOrder(): Promise<string> {
  const res = await SELF.fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify(intake), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(201);
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
    form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
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
      form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
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
