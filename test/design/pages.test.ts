import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves the design editor", async () => {
  const res = await SELF.fetch("https://swagpay.test/design/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="design-app"');
  expect(html).toContain('src="/design/js/app.js"');
});
