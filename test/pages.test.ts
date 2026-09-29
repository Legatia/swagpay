import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/agent/prompt";

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
  expect(await (await SELF.fetch(`${base}/o/${"c".repeat(43)}`)).text()).toContain('id="received"');
});

it("tells the payer exactly what to send, and the agent to repeat amounts exactly", async () => {
  const page = await (await SELF.fetch(`${base}/o/${"c".repeat(43)}`)).text();
  expect(page).toContain("Send exactly the amount shown, on Arc, to the address below. If an exchange takes a withdrawal fee from the amount, the difference shows as still due.");
  expect(page).toContain('id="pay-token"');
  const script = await (await SELF.fetch(`${base}/order.js`)).text();
  expect(script).toContain("send exactly ${p.due} ${p.token} (the rest of this payment)");
  expect(script).toContain("Token: ${payTo.tokens[open.token]}");
  // "We received it" closes the order: the host confirms first.
  expect(script).toContain('if (!confirm("Confirm the swag arrived? This closes the order.")) return;');
  expect(SYSTEM_PROMPT).toContain("Payment events give exact amounts; repeat them exactly, with all six decimals, or not at all.");
});
