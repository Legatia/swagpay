import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import { CREATE_KEY_TTL_MS, PENDING_STALE_MS } from "../src/order-create-keys";

const intake = {
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
};
const base = "https://swagpay.test";
const post = (body: unknown) =>
  new Request(`${base}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = (body: unknown) => SELF.fetch(post(body));
const key = () => crypto.randomUUID();
const orderCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>())!.n;

describe("idempotent order creation", () => {
  it("returns the same order for a repeated key, and creates only one", async () => {
    const k = key();
    const before = await orderCount();
    const first = await create({ ...intake, idempotencyKey: k });
    expect(first.status).toBe(201);
    const a = await first.json<{ token: string; url: string }>();
    const second = await create({ ...intake, idempotencyKey: k });
    expect(second.status).toBe(200);
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(await second.json()).toEqual(a);
    expect(await orderCount()).toBe(before + 1);
  });

  it("refuses the same key with a different order, and a malformed key", async () => {
    const k = key();
    expect((await create({ ...intake, idempotencyKey: k })).status).toBe(201);
    const other = await create({ ...intake, eventName: "Another meetup", idempotencyKey: k });
    expect(other.status).toBe(409);
    for (const bad of ["short", "has spaces in it here", 12345678901234567, "x".repeat(65)]) {
      expect((await create({ ...intake, idempotencyKey: bad })).status).toBe(400);
    }
  });

  it("ignores the Turnstile token when comparing, so a retry with a fresh token replays", async () => {
    const k = key();
    const first = await create({ ...intake, turnstile: "token-1", idempotencyKey: k });
    const second = await create({ ...intake, turnstile: "token-2", idempotencyKey: k });
    expect(second.status).toBe(200);
    expect((await second.json<{ token: string }>()).token).toBe((await first.json<{ token: string }>()).token);
  });

  it("replays before the human check: a Turnstile token is single-use", async () => {
    const strict = ({ ...env, REQUIRE_TURNSTILE: "1" }) as Env;
    const k = key();
    const first = await handleApi(post({ ...intake, turnstile: "good", idempotencyKey: k }), strict, { verifyHuman: async () => true });
    expect(first.status).toBe(201);
    const retry = await handleApi(post({ ...intake, turnstile: "good", idempotencyKey: k }), strict, { verifyHuman: async () => false });
    expect(retry.status).toBe(200);
    expect((await retry.json<{ token: string }>()).token).toBe((await first.json<{ token: string }>()).token);
    // A new key still needs the human check.
    expect((await handleApi(post({ ...intake, idempotencyKey: key() }), strict, { verifyHuman: async () => false })).status).toBe(403);
  });

  it("does not reserve a key when the create is refused, so a corrected retry works", async () => {
    const k = key();
    expect((await create({ ...intake, contactEmail: "nope", idempotencyKey: k })).status).toBe(400);
    expect((await create({ ...intake, idempotencyKey: k })).status).toBe(201);
  });

  it("creates a new order once the key has expired", async () => {
    const k = key();
    const first = await (await create({ ...intake, idempotencyKey: k })).json<{ token: string }>();
    await env.DB.prepare("UPDATE order_create_keys SET created_at = ? WHERE key = ?")
      .bind(new Date(Date.now() - CREATE_KEY_TTL_MS - 1000).toISOString(), k).run();
    const again = await create({ ...intake, idempotencyKey: k });
    expect(again.status).toBe(201);
    expect((await again.json<{ token: string }>()).token).not.toBe(first.token);
  });

  it("asks to retry while the first create is still running, and gives up on a stale reservation", async () => {
    const k = key();
    const hash = "irrelevant-while-pending";
    await env.DB.prepare("INSERT INTO order_create_keys (key, body_hash, created_at) VALUES (?, ?, ?)").bind(k, hash, new Date().toISOString()).run();
    const busy = await create({ ...intake, idempotencyKey: k });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("2");
    await env.DB.prepare("UPDATE order_create_keys SET created_at = ? WHERE key = ?")
      .bind(new Date(Date.now() - PENDING_STALE_MS - 1000).toISOString(), k).run();
    expect((await create({ ...intake, idempotencyKey: k })).status).toBe(201);
  });

  it("releases the key when the order can't be set up", async () => {
    const k = key();
    const broken = ({ ...env, OrderAgent: { idFromName() { throw new Error("agent unavailable"); } } }) as unknown as Env;
    await expect(handleApi(post({ ...intake, idempotencyKey: k }), broken)).rejects.toThrow("agent unavailable");
    expect(await env.DB.prepare("SELECT 1 AS x FROM order_create_keys WHERE key = ?").bind(k).first()).toBeNull();
    expect((await create({ ...intake, idempotencyKey: k })).status).toBe(201);
  });

  it("works as before without a key", async () => {
    const before = await orderCount();
    expect((await create(intake)).status).toBe(201);
    expect((await create(intake)).status).toBe(201);
    expect(await orderCount()).toBe(before + 2);
  });
});
