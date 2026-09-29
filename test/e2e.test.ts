import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RpcClient } from "../src/arc";
import { getOrderByToken } from "../src/db";
import { listEscalations } from "../src/escalations";
import type { TelegramClient } from "../src/telegram";
import { handleTelegram } from "../src/telegram-webhook";
import { runWatcher } from "../src/watcher";
import { completeSpec } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const base = "https://swagpay.test";
const quiet: TelegramClient = { async send() { return 1; }, async answerCallback() {} };

it("runs an order from a complete spec to a paid deposit", async () => {
  // 1. Intake through the API.
  const created = await SELF.fetch(`${base}/api/orders`, {
    method: "POST",
    body: JSON.stringify({
      eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
      deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
      request: "60 black tees with our logo and 500 stickers",
    }),
  });
  const { token } = await created.json<{ token: string }>();
  const order = (await getOrderByToken(env.DB, token))!;
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES ('USD', 4, '2099-09-30', ?), ('EUR', 4.3, '2099-09-30', ?)")
    .bind(new Date().toISOString(), new Date().toISOString()).run();

  // 2. The agent has the complete order and asks the owner for a cost.
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    agent.telegramOverride = quiet;
    agent.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(completeSpec)})`;
    agent.modelOverride = scriptedModel([msg([toolUse("request_printer_cost", { reason: "order complete" })], "tool_use"), msg([], "end_turn")]);
    await agent.processTurn();
  });
  const costRequest = (await listEscalations(env.DB, { status: "open" })).find((e) => e.order_id === order.id && e.kind === "cost")!;

  // 3. The owner answers in Telegram.
  const reply = await handleTelegram(new Request(`${base}/api/telegram`, {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    body: JSON.stringify({ message: { chat: { id: 42 }, text: `/cost ${costRequest.id} 1000` } }),
  }), env, { telegram: quiet });
  expect(reply.status).toBe(200);

  // 4. The agent quotes inside the band.
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

  // 5. The host accepts on the page.
  const view1 = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{ quote: { id: number } }>();
  const accepted = await SELF.fetch(`${base}/api/o/${token}/quote/accept`, { method: "POST", body: JSON.stringify({ quoteId: view1.quote.id }) });
  expect(accepted.status).toBe(201);
  const view2 = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{ payments: Array<{ amount: string }> }>();
  const units = Number(view2.payments[0].amount.replace(".", ""));

  // 6. The deposit lands on Arc as a native USDC send.
  await env.DB.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('last_block', '999')").run();
  const rpc: RpcClient = {
    async blockNumber() { return 1040; }, // the watcher stays HEAD_LAG_BLOCKS (30) behind the head
    async getLogs() {
      return [{
        address: USDC_SYSTEM_EMITTER,
        topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(env.RECEIVING_ADDRESS)],
        data: "0x" + (BigInt(units) * 10n ** 12n).toString(16).padStart(64, "0"),
        blockNumber: "0x3e8", transactionHash: "0x" + "cd".repeat(32), logIndex: "0x0",
      }];
    },
  };
  await runWatcher(env, { rpc, telegram: quiet });

  const view3 = await (await SELF.fetch(`${base}/api/o/${token}`)).json<{ order: { status: string }; payments: Array<{ status: string }> }>();
  expect(view3.order.status).toBe("deposit_paid");
  expect(view3.payments[0].status).toBe("paid");
  await runInDurableObject(stub, async (agent: OrderAgent) => {
    expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain("The deposit is fully paid.");
  });
});
