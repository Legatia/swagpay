import { SELF, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("answers the health check", async () => {
  const res = await SELF.fetch("https://swagpay.test/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("has the D1 schema", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(["decisions", "orders"]));
});
