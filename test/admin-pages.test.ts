import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { createSupplierPayment } from "../src/back-office";
import { setOrderStatus } from "../src/db";
import { createEscalation } from "../src/escalations";
import { createPaymentRequest } from "../src/payments";
import { createObligation, queuePayout, recordPayoutResult } from "../src/treasury";
import { TEAM, makeSigner } from "./access-signer";
import { insertQuote, newOrderRow } from "./fixtures";

async function get(path: string, e: Env = env, opts: { token?: string | null } = {}) {
  const { sign, fetchImpl } = await makeSigner();
  const token = opts.token === undefined ? await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" }) : opts.token;
  return handleAdmin(new Request(`https://swagpay.test${path}`, { headers: token ? { "cf-access-jwt-assertion": token } : {} }), e, { fetch: fetchImpl, rpc: { erc20Balance: async () => 1_234_560_000 } });
}

let nextTag = 7000;

/** An order whose deposit is paid on Arc and whose printer cost the treasury already sent to Kraken. */
async function paidOrder() {
  const { order } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id);
  await setOrderStatus(env.DB, order.id, ["draft"], "deposit_paid");
  const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token: "USDC", cents: 25750, dueBy: new Date(Date.now() + 86_400_000) }, new Date(), () => nextTag++);
  await env.DB.prepare("UPDATE payment_requests SET paid_units = amount_units, status = 'paid', paid_at = ? WHERE id = ?").bind(new Date().toISOString(), req.id).run();
  const hash = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO transfers (tx_hash, log_index, block_number, token, from_address, amount_units, request_id, via, created_at) VALUES (?, 0, 7100, 'USDC', '0x2222222222222222222222222222222222222222', ?, ?, 'amount', ?)")
    .bind(hash, req.amount_units, req.id, new Date().toISOString()).run();
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  const payout = (await queuePayout(env.DB, ob))!;
  await recordPayoutResult(env.DB, payout.id, { status: "sent", ref: "circle-1" });
  const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
  return { order, req, hash, sp };
}

describe("admin pages", () => {
  it("refuses without a valid Access token", async () => {
    expect((await get("/admin", env, { token: null })).status).toBe(403);
    expect((await get("/admin/orders", env, { token: "a.b.c" })).status).toBe(403);
  });

  it("Today lists the printer payment ready to cash out, in the light theme", async () => {
    const { order, sp } = await paidOrder();
    const res = await get("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('<html lang="en" class="light">');
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('href="/admin.css"');
    expect(html).toContain(`/admin/orders/${order.id}`);
    expect(html).toContain("1000.00 PLN");
    expect(html).toContain("ready to cash out");
    expect(html).toContain(`action="/admin/payments/${sp.id}/cashout"`);
    expect(html).toContain(`action="/admin/payments/${sp.id}/paid"`);
    expect(html).toContain('<input type="hidden" name="back" value="/admin">');
    expect(html).toContain("1234.56 USDC");
  });

  it("Today shows open escalations with decide forms, and a cost request links to its order instead of Approve", async () => {
    const { order } = await paidOrder();
    const a = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve <script>x</script>", payload: {} });
    const c = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Price this", payload: {} });
    const html = await (await get("/admin")).text();
    expect(html).toContain("Approve &lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain(`action="/admin/escalations/${a.id}/decide"`);
    expect(html).toContain('value="approve"');
    const costForm = html.slice(html.indexOf("Price this"));
    expect(costForm).toContain(`/admin/orders/${order.id}`);
    expect(html).toContain(`action="/admin/escalations/${c.id}/decide"`);
    expect(html.match(new RegExp(`/admin/escalations/${c.id}/decide[\\s\\S]*?</tr>`))![0]).not.toContain('value="approve"');
  });

  it("a cashing-out row offers the paid form with a confirmation, and a failed withdrawal offers retry", async () => {
    const { sp } = await paidOrder();
    await env.DB.prepare("UPDATE supplier_payments SET status = 'cashing_out' WHERE id = ?").bind(sp.id).run();
    await env.DB.prepare("INSERT INTO cashouts (supplier_payment_id, fiat, fiat_cents, client_order_id, status, error, created_at, updated_at) VALUES (?, 'EUR', 23000, 'c1', 'failed', 'boom', 'x', 'x')").bind(sp.id).run();
    const html = await (await get("/admin")).text();
    expect(html).toContain("withdrawal failed");
    expect(html).toMatch(/\/admin\/cashouts\/\d+\/retry/);
    expect(html).toContain('name="confirm"');
  });

  it("the order ledger shows who paid, with an explorer link, and where the money went", async () => {
    const { order, hash } = await paidOrder();
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "agent", summary: "Discount <i>?", payload: {} });
    const html = await (await get(`/admin/orders/${order.id}`)).text();
    expect(html).toContain("0x2222222222222222222222222222222222222222");
    expect(html).toContain(`href="https://explorer.arc.io/tx/${hash}"`);
    expect(html).toContain("257.50 USDC");
    expect(html).toContain("circle-1");
    expect(html).toContain("1000.00 PLN");
    expect(html).toContain("Estimate");
    expect(html).toContain(`#${e.id}`);
    expect(html).toContain("Discount &lt;i&gt;?");
    expect((await get("/admin/orders/99999999")).status).toBe(404);
    expect((await get("/admin/orders/abc")).status).toBe(404);
  });

  it("orders and printers pages list rows, escaped", async () => {
    const { order } = await paidOrder();
    await env.DB.prepare("UPDATE orders SET event_name = '<b>Meetup</b>' WHERE id = ?").bind(order.id).run();
    const list = await (await get("/admin/orders")).text();
    expect(list).toContain("&lt;b&gt;Meetup&lt;/b&gt;");
    expect(list).not.toContain("<b>Meetup");
    expect(await (await get("/admin/orders?page=1")).text()).toContain("Newer");
    await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, how_to_pay, source_ref, created_at, updated_at) VALUES ('Druk <i>', 'Warsaw', 'PL', '[]', 'partner', 'BLIK 600 000 000', 'w:pages', 'x', 'x')").run();
    const printers = await (await get("/admin/suppliers")).text();
    expect(printers).toContain("Druk &lt;i&gt;");
    expect(printers).toContain("BLIK 600 000 000");
  });

  it("routes: unknown paths 404, other methods are not allowed, msg is shown escaped", async () => {
    expect((await get("/admin/nope")).status).toBe(404);
    const html = await (await get("/admin?msg=" + encodeURIComponent("Done <b>"))).text();
    expect(html).toContain("Done &lt;b&gt;");
    const { sign, fetchImpl } = await makeSigner();
    const token = await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
    const res = await handleAdmin(new Request("https://swagpay.test/admin", { method: "PUT", headers: { "cf-access-jwt-assertion": token } }), env, { fetch: fetchImpl });
    expect(res.status).toBe(405);
  });

  it("warns when the wallet runner hasn't polled for an hour", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO runner_state (key, value) VALUES ('last_seen', ?)").bind(new Date(Date.now() - 2 * 3_600_000).toISOString()).run();
    expect(await (await get("/admin")).text()).toContain("The wallet runner last polled");
  });
});
