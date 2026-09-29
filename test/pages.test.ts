import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const base = "https://swagpay.test";

it("serves the landing page, the form and the order page", async () => {
  const home = await SELF.fetch(`${base}/`);
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("Swagpay");

  const form = await SELF.fetch(`${base}/new`);
  expect(form.status).toBe(200);
  expect(await form.text()).toContain('id="order-form"');

  const order = await SELF.fetch(`${base}/o/${"a".repeat(43)}`);
  expect(order.status).toBe(200);
  expect(await order.text()).toContain('id="thread"');
  expect(await (await SELF.fetch(`${base}/o/${"b".repeat(43)}`)).text()).toContain('id="pay-box"');
});
