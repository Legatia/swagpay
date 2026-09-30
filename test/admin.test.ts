import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { createEscalation } from "../src/escalations";
import { TEAM, makeSigner } from "./access-signer";

async function admin(e: Env): Promise<Response> {
  const { sign, fetchImpl } = await makeSigner();
  const token = await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
  return handleAdmin(new Request("https://swagpay.test/admin", { headers: { "cf-access-jwt-assertion": token } }), e, { fetch: fetchImpl, rpc: { erc20Balance: async () => 0 } });
}

describe("/admin", () => {
  it("shows an open escalation to a verified owner, escaped", async () => {
    await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Approve <script>x</script>", payload: {} });
    const res = await admin(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Approve &lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("owner@example.com");
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
    const configured = await (await admin(({ ...env, TELEGRAM_BOT_TOKEN: "t", REQUIRE_TURNSTILE: "1", TURNSTILE_SECRET: "s", TREASURY_RUNNER_TOKEN: "" }) as Env)).text();
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
    const off = ({ ...env, ACCESS_AUD: "" }) as unknown as Env;
    expect((await handleAdmin(new Request("https://swagpay.test/admin"), off)).status).toBe(503);
  });
});
