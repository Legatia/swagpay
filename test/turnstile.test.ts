import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SITEVERIFY_URL, verifyTurnstile } from "../src/turnstile";
import { handleApi } from "../src/api";

function fakeFetch(body: unknown, seen: { url?: string; form?: FormData }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), form: init?.body as FormData });
    return Response.json(body);
  }) as typeof fetch;
}

const intake = {
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
};
const envWith = (o: Record<string, unknown>) => ({ ...env, ...o }) as Env;
const post = (body: unknown) => new Request("https://swagpay.test/api/orders", { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": "203.0.113.9" } });

describe("verifyTurnstile", () => {
  it("sends the secret, token and IP and trusts only success: true", async () => {
    const seen: { url?: string; form?: FormData }[] = [];
    expect(await verifyTurnstile("tok", "203.0.113.9", "sec", fakeFetch({ success: true }, seen))).toBe(true);
    expect(seen[0].url).toBe(SITEVERIFY_URL);
    expect(seen[0].form?.get("secret")).toBe("sec");
    expect(seen[0].form?.get("response")).toBe("tok");
    expect(seen[0].form?.get("remoteip")).toBe("203.0.113.9");
    expect(await verifyTurnstile("tok", null, "sec", fakeFetch({ success: false }))).toBe(false);
  });

  it("fails closed on bad tokens and network errors", async () => {
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await verifyTurnstile(undefined, null, "sec", fakeFetch({ success: true }))).toBe(false);
    expect(await verifyTurnstile("", null, "sec", fakeFetch({ success: true }))).toBe(false);
    expect(await verifyTurnstile("tok", null, "sec", boom)).toBe(false);
  });
});

describe("new-order gate", () => {
  it("rejects a new order that fails the human check when Turnstile is required", async () => {
    const res = await handleApi(post({ ...intake, turnstile: "bad" }), envWith({ REQUIRE_TURNSTILE: "1" }), { verifyHuman: async () => false });
    expect(res.status).toBe(403);
  });

  it("creates the order when the check passes", async () => {
    let got: unknown;
    const res = await handleApi(post({ ...intake, turnstile: "good" }), envWith({ REQUIRE_TURNSTILE: "1" }), {
      verifyHuman: async (token, ip) => { got = [token, ip]; return true; },
    });
    expect(res.status).toBe(201);
    expect(got).toEqual(["good", "203.0.113.9"]);
  });

  it("serves the site key to the form", async () => {
    const res = await handleApi(new Request("https://swagpay.test/api/config"), env);
    expect(await res.json()).toEqual({ turnstileSiteKey: "1x00000000000000000000AA" });
  });

  it("fails closed without a secret, on a null body, and on an unknown REQUIRE_TURNSTILE value", async () => {
    const noSecret = envWith({ REQUIRE_TURNSTILE: "1", TURNSTILE_SECRET: "" });
    expect((await handleApi(post({ ...intake, turnstile: "good" }), noSecret)).status).toBe(403);
    expect((await handleApi(post(null), envWith({ REQUIRE_TURNSTILE: "1" }), { verifyHuman: async () => false })).status).toBe(403);
    expect((await handleApi(post({ ...intake, turnstile: "x" }), envWith({ REQUIRE_TURNSTILE: "true" }), { verifyHuman: async () => false })).status).toBe(403);
  });
});
