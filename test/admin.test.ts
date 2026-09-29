import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { createOrder } from "../src/db";
import { createEscalation, decideEscalation } from "../src/escalations";
import { IntakeSchema } from "../src/intake";
import { TEAM, makeSigner } from "./access-signer";

async function admin(e: Env): Promise<Response> {
  const { sign, fetchImpl } = await makeSigner();
  const token = await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
  return handleAdmin(new Request("https://swagpay.test/admin", { headers: { "cf-access-jwt-assertion": token } }), e, { fetch: fetchImpl });
}

describe("/admin", () => {
  it("shows open escalations and orders to a verified owner, escaped", async () => {
    const { order } = await createOrder(env.DB, IntakeSchema.parse({
      eventName: "<b>Meetup</b>", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
      deliveryPlace: "Kolektyw3", contactName: "Ana", contactEmail: "ana@example.com", request: "60 black tees please",
    }), new Date("2099-01-01T10:00:00Z"));
    await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve <script>x</script>", payload: {} });
    const { sign, fetchImpl } = await makeSigner();
    const token = await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
    const res = await handleAdmin(new Request("https://swagpay.test/admin", { headers: { "cf-access-jwt-assertion": token } }), env, { fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Approve &lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Meetup&lt;/b&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("owner@example.com");
  });

  it("shows recent decisions, escaped, and whether the agent was told", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "agent", summary: "Discount?", payload: {} });
    await decideEscalation(env.DB, e.id, "rejected", "<b>not this time</b>");
    const n = await createEscalation(env.DB, { orderId: null, kind: "system", summary: "Model failed", payload: {} });
    await decideEscalation(env.DB, n.id, "approved", null);
    const html = await (await admin(env)).text();
    expect(html).toContain("Recent decisions");
    expect(html).toContain("&lt;b&gt;not this time&lt;/b&gt;");
    expect(html).not.toContain("<b>not this time");
    expect(html).toMatch(new RegExp(`<td>#${e.id}</td>.*?<td>rejected</td>.*?<td>no</td></tr>`));
    expect(html).toMatch(new RegExp(`<td>#${n.id}</td>.*?<td>acknowledged</td>`));
  });

  const setUsdRate = (fetchedAt: Date) =>
    env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?)").bind(fetchedAt.toISOString()).run();

  it("warns about missing Telegram and Turnstile config", async () => {
    // The test env has no bot token and doesn't require Turnstile.
    await setUsdRate(new Date());
    const html = await (await admin(env)).text();
    expect(html).toContain('<p class="error">Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID).</p>');
    expect(html).not.toContain("Turnstile secret is missing");
    const strict = await (await admin(({ ...env, REQUIRE_TURNSTILE: "1", TURNSTILE_SECRET: "" }) as Env)).text();
    expect(strict).toContain('<p class="error">Turnstile secret is missing: new orders are refused.</p>');
    const configured = await (await admin(({ ...env, TELEGRAM_BOT_TOKEN: "t", REQUIRE_TURNSTILE: "1", TURNSTILE_SECRET: "s" }) as Env)).text();
    expect(configured).not.toContain('class="error"');
  });

  it("warns when hosts can't accept quotes or quotes are paused", async () => {
    await setUsdRate(new Date());
    const address = '<p class="error">RECEIVING_ADDRESS is missing or malformed: hosts can&#39;t accept quotes.</p>';
    const rates = '<p class="error">Exchange rates are stale or missing: quotes are paused.</p>';
    expect(await (await admin(env)).text()).not.toContain(address);
    expect(await (await admin(({ ...env, RECEIVING_ADDRESS: "" }) as Env)).text()).toContain(address);
    expect(await (await admin(({ ...env, RECEIVING_ADDRESS: "0x1234" as string }) as Env)).text()).toContain(address);
    expect(await (await admin(env)).text()).not.toContain(rates);
    await setUsdRate(new Date(Date.now() - 7 * 3_600_000));
    expect(await (await admin(env)).text()).toContain(rates);
    await env.DB.prepare("DELETE FROM fx_rates").run();
    expect(await (await admin(env)).text()).toContain(rates);
    await setUsdRate(new Date());
  });

  it("refuses without a valid token, and is off when Access isn't configured", async () => {
    expect((await SELF.fetch("https://swagpay.test/admin")).status).toBe(403);
    expect((await SELF.fetch("https://swagpay.test/admin/")).status).toBe(403);
    const off = ({ ...env, ACCESS_AUD: "" }) as Env;
    expect((await handleAdmin(new Request("https://swagpay.test/admin"), off)).status).toBe(503);
  });
});
