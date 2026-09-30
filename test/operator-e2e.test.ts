import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import type { ModelClient, ModelRequest } from "../src/agent/model";
import { TREASURY_NAME, type TreasuryAgent } from "../src/agent/treasury-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RawLog, type RpcClient } from "../src/arc";
import { getOrderById, getOrderByToken, saveOrderSpec } from "../src/db";
import { listEscalations } from "../src/escalations";
import { formatUnits } from "../src/money";
import { listPaymentRequests } from "../src/payments";
import type { TelegramClient } from "../src/telegram";
import { handleTelegram } from "../src/telegram-webhook";
import { createObligation, getObligation, queuePayout, type ObligationRow } from "../src/treasury";
import { createSupplierPayment } from "../src/back-office";
import { runWatcher } from "../src/watcher";
import { handleAdmin } from "../src/admin";
import { getSupplierPayment } from "../src/back-office";
import { TEAM, makeSigner } from "./access-signer";
import { completeSpec, insertQuote, newOrderRow } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const base = "https://swagpay.test";
const runner = { authorization: "Bearer runner-secret" };
const PAYER = "0x2222222222222222222222222222222222222222";
const PRINTER_COST_UNITS = 257_500_000; // 1000 PLN at 4 PLN/USD with the 3% FX buffer
const quiet: TelegramClient = { async send() { return 1; }, async answerCallback() {} };

/** The owner's chat: what the bot sent them. */
function ownerChat() {
  const sent: string[] = [];
  const telegram: TelegramClient = { async send(_chat, text) { sent.push(text); return 1; }, async answerCallback() {} };
  return { sent, telegram };
}

/** A chain head and the USDC logs on it; the wallet holds 10,000 USDC. */
function fakeRpc(head: number, logs: RawLog[] = []): RpcClient {
  return {
    async chainId() { return 5042; },
    async blockNumber() { return head; },
    async getLogs(f) { return logs.filter((l) => Number(l.blockNumber) >= f.fromBlock && Number(l.blockNumber) <= f.toBlock); },
    async erc20Balance() { return 10_000_000_000; },
  };
}

// Native USDC on Arc: the system emitter, 18 decimals.
const usdcLog = (block: number, units: number, n: number): RawLog => ({
  address: USDC_SYSTEM_EMITTER,
  topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(env.RECEIVING_ADDRESS)],
  data: "0x" + (BigInt(units) * 10n ** 12n).toString(16).padStart(64, "0"),
  blockNumber: "0x" + block.toString(16), transactionHash: "0x" + n.toString(16).padStart(64, "0"), logIndex: "0x0",
});

const telegramUpdate = (text: string) => new Request(`${base}/api/telegram`, {
  method: "POST",
  headers: { "x-telegram-bot-api-secret-token": "test-secret" },
  body: JSON.stringify({ message: { chat: { id: 42 }, text } }),
});

type RunnerPayout = { id: number; obligationId: number; method: string; chain: string; token: string; amount: string; destination: string; idempotencyKey: string };
const listPayouts = async () => (await (await SELF.fetch(`${base}/api/treasury/payouts`, { headers: runner })).json<{ payouts: RunnerPayout[] }>()).payouts;
const postResult = (id: number, body: unknown) =>
  SELF.fetch(`${base}/api/treasury/payouts/${id}/result`, { method: "POST", headers: runner, body: JSON.stringify(body) });

it("runs one order from intake through the printer payout, balance, delivery and reserve sweep", async () => {
  // 1. Intake through the API.
  const created = await SELF.fetch(`${base}/api/orders`, {
    method: "POST",
    body: JSON.stringify({
      eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
      deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
      request: "60 black tees with our logo and 500 stickers",
    }),
  });
  expect(created.status).toBe(201);
  const { token } = await created.json<{ token: string }>();
  const order = (await getOrderByToken(env.DB, token))!;
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?), ('EUR', 4.3, '2099-09-30', ?)")
    .bind(new Date().toISOString(), new Date().toISOString()).run();

  // 2. The order agent has the complete spec and asks the owner for a cost.
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    agent.telegramOverride = quiet;
    agent.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(completeSpec)})`;
    await saveOrderSpec(env.DB, order.id, completeSpec);
    agent.modelOverride = scriptedModel([msg([toolUse("request_printer_cost", { reason: "order complete" })], "tool_use"), msg([], "end_turn")]);
    await agent.processTurn();
  });
  const costRequest = (await listEscalations(env.DB, { status: "open" })).find((e) => e.order_id === order.id && e.kind === "cost")!;
  expect(costRequest).toBeDefined();

  // 3. The owner answers with the printer's price.
  expect((await handleTelegram(telegramUpdate(`/cost ${costRequest.id} 1000`), env, { telegram: quiet })).status).toBe(200);

  // 4. The order agent quotes inside the band.
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    const model = scriptedModel([
      msg([toolUse("send_quote", { currency: "USD", price: 380, message: "Here is your price.", reason: "cost arrived" })], "tool_use"),
      msg([], "end_turn"),
    ]);
    agent.modelOverride = model;
    await agent.processTurn();
    expect(JSON.stringify(model.requests[0].messages.at(-1))).toContain("allowed price is 360.50–386.25 USD");
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain("Quote #");
  });

  // 5. The host accepts on the order page.
  const view1 = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{ quote: { id: number } }>();
  const accepted = await SELF.fetch(`${base}/api/o/${token}/quote/accept`, { method: "POST", body: JSON.stringify({ quoteId: view1.quote.id }) });
  expect(accepted.status).toBe(201);
  const deposit = (await listPaymentRequests(env.DB, order.id)).find((r) => r.stage === "deposit")!;
  expect(deposit.token).toBe("USDC");

  // 6. The deposit lands on Arc: exactly the tagged amount.
  await env.DB.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('last_block', '999')").run();
  await runWatcher(env, { rpc: fakeRpc(1040, [usdcLog(1000, deposit.amount_units, 1)]), telegram: quiet });
  expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");

  // 7. The completed deposit opens the printer-cost obligation to the payout account.
  const cost = (await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).first<ObligationRow>())!;
  expect(cost).toMatchObject({
    status: "open", token: "USDC", amount_units: PRINTER_COST_UNITS, destination: env.PAYOUT_ADDRESS, chain: "MATIC",
    source_ref: `printer_cost:quote:${view1.quote.id}`, approved_by: null,
  });

  // 8. Treasury turn: the agent queues the printer's money.
  const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
  await runInDurableObject(treasury, async (agent: TreasuryAgent) => {
    agent.telegramOverride = quiet;
    agent.rpcOverride = fakeRpc(1040);
    const model = scriptedModel([
      msg([toolUse("pay_obligation", { obligationId: cost.id, reason: "deposit paid; the printer's cost goes to the payout account" })], "tool_use"),
      msg([], "end_turn"),
    ]);
    agent.modelOverride = model;
    expect((await agent.processTurn())?.status).toBe("waiting");
    const woke = JSON.stringify(model.requests[0].messages.at(-1));
    expect(woke).toContain(`Obligation #${cost.id}: printer cost 257.500000 USDC to the payout account (open)`);
    expect(woke).toContain("Treasury snapshot: wallet 10000.000000 USDC");
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain("Queued payout #");
  });
  expect((await getObligation(env.DB, cost.id))?.status).toBe("queued");

  // 9. The wallet runner picks it up (a CCTP bridge to Polygon) and reports it sent.
  const [printerPayout, ...extra1] = await listPayouts();
  expect(extra1).toEqual([]);
  expect(printerPayout).toMatchObject({ obligationId: cost.id, method: "bridge", chain: "MATIC", token: "USDC", amount: "257.500000", destination: env.PAYOUT_ADDRESS });
  expect((await postResult(printerPayout.id, { status: "sent", ref: "circle-tx-1" })).status).toBe(200);
  expect(await getObligation(env.DB, cost.id)).toMatchObject({ status: "paid", approved_by: null });
  expect(await listPayouts()).toEqual([]);

  // 10. The owner paid the printer by card; the job is printed. The balance request goes to the host.
  const chat = ownerChat();
  expect((await handleTelegram(telegramUpdate(`/printed ${order.id}`), env, { telegram: chat.telegram })).status).toBe(200);
  expect(chat.sent.join("\n")).toMatch(new RegExp(`Order ${order.id}: printed; balance request #\\d+`));
  expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_pending");
  const balance = (await listPaymentRequests(env.DB, order.id)).find((r) => r.stage === "balance")!;
  expect(balance).toMatchObject({ status: "open", token: "USDC" });
  expect(Math.floor(balance.amount_units / 10_000)).toBe(12_250); // 380.00 − 257.50 USD, then the tag

  // 11. The balance lands on Arc, well below the lagged head.
  await runWatcher(env, { rpc: fakeRpc(2040, [usdcLog(2000, balance.amount_units, 2)]), telegram: quiet });
  expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_paid");
  expect((await listPaymentRequests(env.DB, order.id)).every((r) => r.status === "paid")).toBe(true);

  // 12. The host presses "We received it": the order closes and the treasury hears about it.
  const received = await SELF.fetch(`${base}/api/o/${token}/received`, { method: "POST" });
  expect(received.status).toBe(201);
  expect((await getOrderById(env.DB, order.id))?.status).toBe("closed");

  // 13. Treasury turn: sweep 20% of the margin to the reserve, then pay that reserve obligation.
  const receivedUnits = deposit.amount_units + balance.amount_units;
  const reserveUnits = Math.floor(((receivedUnits - PRINTER_COST_UNITS) * 2000) / 10_000);
  const requests: ModelRequest[] = [];
  let reserveId = 0;
  const sweeper: ModelClient = {
    async create(req) {
      requests.push(structuredClone(req));
      if (requests.length === 1) {
        return msg([toolUse("sweep_to_reserve", { orderId: order.id, bps: 2000, reason: "order closed; 20% of its margin to the reserve" })], "tool_use");
      }
      if (requests.length === 2) {
        // The model reads the new obligation's number from the tool result; the test reads it from D1.
        reserveId = (await env.DB.prepare("SELECT id FROM obligations WHERE kind = 'reserve' AND order_id = ?").bind(order.id).first<{ id: number }>())!.id;
        return msg([toolUse("pay_obligation", { obligationId: reserveId, reason: "move the reserve share to the reserve address" })], "tool_use");
      }
      return msg([], "end_turn");
    },
  };
  await runInDurableObject(treasury, async (agent: TreasuryAgent) => {
    agent.telegramOverride = quiet;
    agent.rpcOverride = fakeRpc(2040);
    agent.modelOverride = sweeper;
    expect((await agent.processTurn())?.status).toBe("waiting");
  });
  expect(requests).toHaveLength(3);
  const closeEvents = JSON.stringify(requests[0].messages.at(-1));
  expect(closeEvents).toContain(`Payout #${printerPayout.id} for obligation #${cost.id} sent (ref circle-tx-1).`);
  expect(closeEvents).toContain(`Order ${order.id} closed. Decide its reserve sweep.`);
  expect(JSON.stringify(requests[1].messages.at(-1))).toContain(`Reserve obligation #${reserveId}: ${formatUnits(reserveUnits)} USDC to the reserve.`);
  expect(JSON.stringify(requests[2].messages.at(-1))).toContain("Queued payout #");
  expect(await getObligation(env.DB, reserveId)).toMatchObject({
    kind: "reserve", status: "queued", token: "USDC", amount_units: reserveUnits, destination: env.RESERVE_ADDRESS, chain: "ARC",
  });

  // 14. The runner sends the reserve on Arc and reports it.
  const [reservePayout, ...extra2] = await listPayouts();
  expect(extra2).toEqual([]);
  expect(reservePayout).toMatchObject({ obligationId: reserveId, method: "transfer", chain: "ARC", token: "USDC", amount: formatUnits(reserveUnits), destination: env.RESERVE_ADDRESS });
  expect(reservePayout.idempotencyKey).not.toBe(printerPayout.idempotencyKey);
  expect((await postResult(reservePayout.id, { status: "sent", ref: "circle-tx-2" })).status).toBe(200);
  expect(await getObligation(env.DB, reserveId)).toMatchObject({ status: "paid", approved_by: null });

  // 15. Nothing needed the owner's approval, and the public numbers add up.
  expect((await listEscalations(env.DB)).filter((e) => e.kind === "approval" || e.kind === "system")).toEqual([]);
  const metrics = await (await SELF.fetch(`${base}/api/metrics`)).json<{
    orders: Record<string, number>;
    received: { USDC: string; EURC: string };
    paidOut: { USDC: string; EURC: string };
    obligations: { settledByAgent: number; settledWithOwner: number; open: number };
    decisions: { total: number; escalated: number; blocked: number };
  }>();
  expect(metrics.orders).toEqual({ closed: 1 });
  expect(metrics.received).toEqual({ USDC: formatUnits(receivedUnits), EURC: "0.000000" });
  expect(metrics.paidOut).toEqual({ USDC: formatUnits(PRINTER_COST_UNITS + reserveUnits), EURC: "0.000000" });
  expect(metrics.obligations).toEqual({ settledByAgent: 2, settledWithOwner: 0, open: 0 });
  // Five tool calls in all; the only escalation is the order agent asking the owner for the printer's price.
  expect(metrics.decisions).toEqual({ total: 5, escalated: 1, blocked: 0 });

  // 16. The public log shows both agents' decisions for this order.
  const { decisions } = await (await SELF.fetch(`${base}/api/log`)).json<{ decisions: Array<{ order: number | null; agent: string; tool: string; reason: string; outcome: string }> }>();
  const rows = decisions.map((d) => ({ order: d.order, agent: d.agent, tool: d.tool, outcome: d.outcome }));
  expect(rows).toHaveLength(5);
  expect(rows).toEqual(expect.arrayContaining([
    { order: order.id, agent: "order", tool: "request_printer_cost", outcome: "escalated" },
    { order: order.id, agent: "order", tool: "send_quote", outcome: "done" },
    { order: order.id, agent: "treasury", tool: "pay_obligation", outcome: "done" },
    { order: order.id, agent: "treasury", tool: "sweep_to_reserve", outcome: "done" },
  ]));
  expect(rows.filter((d) => d.agent === "treasury" && d.tool === "pay_obligation")).toHaveLength(2);
  expect(decisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ agent: "treasury", tool: "sweep_to_reserve", reason: "order closed; 20% of its margin to the reserve" }),
  ]));
});

it("cashes out a printer payment: payout reaches Kraken, runner sells and withdraws, owner marks it paid", async () => {
  const VENDOR_PHONE = "BLIK to 600 111 222";
  const { order } = await newOrderRow();
  const vendor = (await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, how_to_pay, pay_currency, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES ('Druk E2E', 'Warsaw', 'PL', '[]', 'partner', ?, 'PLN', '0x3333333333333333333333333333333333333333', 'MATIC', 'w:e2e-cashout', 'x', 'x') RETURNING id").bind(VENDOR_PHONE).first<{ id: number }>())!.id;
  const quoteId = await insertQuote(env.DB, order.id);
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('EUR', 4.3, '2099-09-30', ?), ('USD', 4, '2099-09-30', ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
  const metricsUrl = `${base}/api/metrics`;

  // The treasury's payout of the printer cost to Kraken, as the runner sees it.
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: PRINTER_COST_UNITS, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  const payout = (await queuePayout(env.DB, ob))!;
  expect((await listPayouts()).some((p) => p.id === payout.id)).toBe(true);
  expect((await postResult(payout.id, { status: "sent", ref: "circle-tx-e2e" })).status).toBe(200);
  const before = await (await SELF.fetch(metricsUrl)).json();
  const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: vendor, currency: "PLN", amountCents: 100_000 });

  // The owner presses Cash out, through the Access-protected dashboard.
  const { sign, fetchImpl } = await makeSigner();
  const jwt = await sign({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
  const admin = (path: string, init: RequestInit = {}) => handleAdmin(new Request(`${base}${path}`, { ...init, headers: { "cf-access-jwt-assertion": jwt, origin: base, "content-type": "application/x-www-form-urlencoded" } }), env, { fetch: fetchImpl, rpc: { erc20Balance: async () => 1_000_000_000 } });
  const cashed = await admin(`/admin/payments/${sp.id}/cashout`, { method: "POST", body: "back=%2Fadmin" });
  expect(cashed.status).toBe(303);
  expect(decodeURIComponent(cashed.headers.get("location")!)).toContain("Cash-out queued");
  expect(await (await admin("/admin")).text()).not.toContain("ready to pay");

  // The runner finds it, sells, withdraws.
  const listed = (await (await SELF.fetch(`${base}/api/treasury/cashouts`, { headers: runner })).json<{ cashouts: Array<{ id: number; fiat: string; amount: string; status: string }> }>()).cashouts;
  const c = listed.find((x) => x.amount === "237.21")!;
  expect(c).toMatchObject({ fiat: "EUR", status: "queued" });
  const res = (b: unknown) => SELF.fetch(`${base}/api/treasury/cashouts/${c.id}/result`, { method: "POST", headers: runner, body: JSON.stringify(b) });
  expect((await res({ stage: "sold", orderRef: "OTX-E2E", soldUnits: "273.089785" })).status).toBe(200);
  expect((await res({ stage: "withdrawn", withdrawalRef: "WREF-E2E", feeCents: 100 })).status).toBe(200);

  // Today shows it ready to pay; Paid (card) closes it.
  expect(await (await admin("/admin")).text()).toContain("ready to pay");
  const paid = await admin(`/admin/payments/${sp.id}/paid`, { method: "POST", body: new URLSearchParams({ back: "/admin", method: "card", date: "2099-10-02" }).toString() });
  expect(paid.status).toBe(303);
  expect((await getSupplierPayment(env.DB, sp.id))?.status).toBe("paid");
  expect(await (await admin("/admin")).text()).not.toContain("ready to pay");
  const ledger = await (await admin(`/admin/orders/${order.id}`)).text();
  expect(ledger).toContain("Printer payment: 1000.00 PLN, paid");
  expect(ledger).toContain("card, reference");

  // Public numbers do not move for the cash-out; the owner got exactly one "withdrawn" notice; no agent heard the printer's payment details.
  expect(await (await SELF.fetch(metricsUrl)).json()).toEqual(before);
  const notices = (await listEscalations(env.DB)).filter((e) => e.summary.includes(`withdrawn to your EUR account for order ${order.id}`));
  expect(notices).toHaveLength(1);
  expect(notices[0].order_id).toBeNull();
  expect(notices[0].summary).not.toContain("600 111 222");
  const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
  const orderAgent = await getAgentByName(env.OrderAgent, order.instance);
  for (const stub of [treasury, orderAgent]) {
    const inbox = await runInDurableObject(stub as never, async (_agent: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL)");
      return state.storage.sql.exec("SELECT text FROM inbox").toArray().map((r) => String(r.text)).join("\n");
    });
    expect(inbox).not.toContain("600 111 222");
  }
});
