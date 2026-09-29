import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { createOrder } from "../src/db";
import { createEscalation } from "../src/escalations";
import { IntakeSchema } from "../src/intake";
import { TEAM, makeSigner } from "./access-signer";

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

  it("refuses without a valid token, and is off when Access isn't configured", async () => {
    expect((await SELF.fetch("https://swagpay.test/admin")).status).toBe(403);
    expect((await SELF.fetch("https://swagpay.test/admin/")).status).toBe(403);
    const off = ({ ...env, ACCESS_AUD: "" }) as Env;
    expect((await handleAdmin(new Request("https://swagpay.test/admin"), off)).status).toBe(503);
  });
});
