import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RawLog, type RpcClient } from "../src/arc";
import { supplierPaymentForOrder } from "../src/back-office";
import { getOrderById, setOrderStatus } from "../src/db";
import { listEscalations } from "../src/escalations";
import { addClaim, createPaymentRequest, listUnnotified } from "../src/payments";
import { handleTelegram } from "../src/telegram-webhook";
import { warsawTime } from "../src/quote-text";
import { formatUnits } from "../src/money";
import { getQuote } from "../src/quotes";
import { createObligation, getObligation, orderMargin, printerCostUnits, type ObligationRow } from "../src/treasury";
import type { TelegramClient } from "../src/telegram";
import { proposeVendorJob, setVendorStatus, vendorJobFor, type VendorStatus } from "../src/vendors";
import { CHUNK_BLOCKS, HEAD_LAG_BLOCKS, MIN_ESCALATION_UNITS, runWatcher } from "../src/watcher";
import { insertQuote, intakeFor, newOrderRow } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const TO = "0x1111111111111111111111111111111111111111";
const silent: TelegramClient = { async send() { return null; }, async answerCallback() {} };

function fakeRpc(latest: number, logs: RawLog[] = [], chain = 5042) {
  const calls: { fromBlock: number; toBlock: number; address: string[]; topics: (string | null)[] }[] = [];
  const rpc: RpcClient = {
    async chainId() { return chain; },
    async blockNumber() { return latest; },
    async getLogs(f) {
      calls.push(f);
      return logs.filter((l) => Number(l.blockNumber) >= f.fromBlock && Number(l.blockNumber) <= f.toBlock);
    },
  };
  return { rpc, calls };
}

const usdcLog = (block: number, units: number, n: number): RawLog => ({
  address: USDC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(TO)],
  data: "0x" + (BigInt(units) * 10n ** 12n).toString(16).padStart(64, "0"),
  blockNumber: "0x" + block.toString(16), transactionHash: "0x" + n.toString(16).padStart(64, "0"), logIndex: "0x0",
});

async function setLastBlock(n: number) {
  await env.DB.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('last_block', ?)").bind(String(n)).run();
}

async function pendingDeposit(tag: number, opts: { init?: boolean; pending?: boolean; dueBy?: Date; currency?: "USD" | "EUR" } = {}) {
  const { order } = await newOrderRow();
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  if (opts.init !== false) await stub.init(order.id, intakeFor());
  const quoteId = await insertQuote(env.DB, order.id, { currency: opts.currency ?? "USD" });
  if (opts.pending !== false) await setOrderStatus(env.DB, order.id, ["draft"], "deposit_pending");
  const dueBy = opts.dueBy ?? new Date(Date.now() + 48 * 3_600_000);
  const token = opts.currency === "EUR" ? "EURC" : "USDC";
  const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token, cents: 25750, dueBy }, new Date(), () => tag);
  return { order, stub, req };
}

describe("runWatcher", () => {
  it("completes the balance and asks the host to confirm delivery", async () => {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intakeFor());
    const quoteId = await insertQuote(env.DB, order.id);
    await env.DB.prepare("UPDATE orders SET status = 'balance_pending' WHERE id = ?").bind(order.id).run();
    const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "balance", token: "USDC", cents: 12250, dueBy: new Date(Date.now() + 86_400_000) }, new Date(), () => 7575);
    await setLastBlock(4000);
    await runWatcher(env, { rpc: fakeRpc(4040, [usdcLog(4010, req.amount_units, 7575)]).rpc, telegram: silent });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_paid");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n")).toContain("The balance is fully paid.");
    });
    const notice = (await listEscalations(env.DB)).find((e) => e.order_id === order.id && e.summary.includes("balance paid"));
    expect(notice?.summary).toContain("Deliver the swag");
  });

  it("starts at the current block on its first run", async () => {
    await env.DB.prepare("DELETE FROM watcher_state").run();
    const { rpc, calls } = fakeRpc(1_000_000);
    expect(await runWatcher(env, { rpc, telegram: silent })).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe(String(1_000_000 - HEAD_LAG_BLOCKS));
  });

  it("reads both emitters for the receiving address in 5,000-block chunks", async () => {
    await setLastBlock(0);
    const { rpc, calls } = fakeRpc(12_030);
    const r = await runWatcher(env, { rpc, telegram: silent });
    expect(r).toMatchObject({ from: 1, to: 12_000 });
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([[1, 5000], [5001, 10_000], [10_001, 12_000]]);
    expect(calls[0].address).toEqual([USDC_SYSTEM_EMITTER, env.EURC_ADDRESS.toLowerCase()]);
    expect(calls[0].topics).toEqual([TRANSFER_TOPIC, null, addressTopic(TO)]);
    expect(CHUNK_BLOCKS).toBe(5000);
  });

  it("credits a deposit, moves the order and tells the agent once", async () => {
    const { order, stub, req } = await pendingDeposit(4242);
    await setLastBlock(100);
    const { rpc } = fakeRpc(135, [usdcLog(105, req.amount_units, 1)]);
    const r = await runWatcher(env, { rpc, telegram: silent });
    expect(r?.outcomes).toHaveLength(1);
    expect(r?.outcomes[0].kind).toBe("matched");
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n");
      expect(inbox).toContain(`Payment received on Arc: 257.504242 USDC for deposit request #${req.id}`);
      expect(inbox).toContain("The deposit is fully paid.");
    });
    await setLastBlock(100);
    const again = await runWatcher(env, { rpc, telegram: silent });
    expect(again?.outcomes).toEqual([{ kind: "duplicate" }]);
  });

  it("credits a late deposit but has the owner confirm printing before booking", async () => {
    const due = new Date(Date.now() - 3_600_000);
    const { order, stub, req } = await pendingDeposit(4545, { dueBy: due });
    await setLastBlock(1400);
    const paid = usdcLog(1405, req.amount_units, 15);
    await runWatcher(env, { rpc: fakeRpc(1440, [paid]).rpc, telegram: silent });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n");
      expect(inbox).toContain("The deposit arrived after it was due; the owner will confirm whether printing is still possible before anything is booked.");
      expect(inbox).not.toContain("The deposit is fully paid.");
    });
    const late = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.kind === "approval");
    expect(late).toHaveLength(1);
    expect(late[0].summary).toContain(`Order ${order.id}: deposit paid LATE (due ${warsawTime(due)} Warsaw time)`);
    expect(late[0].summary).toContain("cost 1000.00 PLN gross");
    const ob = await env.DB.prepare("SELECT status FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).first<{ status: string }>();
    expect(ob?.status).toBe("escalated");
    expect((await listEscalations(env.DB)).some((x) => x.order_id === order.id && x.kind === "payment" && x.summary.includes("Book the printer"))).toBe(false);
  });

  it("opens an escalation without an order for a transfer that matches nothing", async () => {
    await setLastBlock(200);
    const sent: string[] = [];
    const telegram: TelegramClient = { async send(_c, text) { sent.push(text); return 1; }, async answerCallback() {} };
    const { rpc } = fakeRpc(240, [usdcLog(205, 77_000_000, 2)]);
    await runWatcher(env, { rpc, telegram });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.kind === "payment" && x.summary.includes("77.000000 USDC"));
    expect(e?.order_id).toBeNull();
    expect(sent.some((s) => s.includes("Unmatched transfer: 77.000000 USDC"))).toBe(true);
  });

  it("credits a claimed transfer that first arrived unmatched", async () => {
    const { order, req } = await pendingDeposit(5151);
    await setLastBlock(300);
    const odd = usdcLog(305, 250_000_000, 3);
    await runWatcher(env, { rpc: fakeRpc(340, [odd]).rpc, telegram: silent });
    await addClaim(env.DB, req.id, odd.transactionHash);
    const r = await runWatcher(env, { rpc: fakeRpc(340).rpc, telegram: silent });
    expect(r?.outcomes.map((o) => o.kind)).toEqual(["matched"]);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_pending");
    const flagged = (await listEscalations(env.DB, { status: "open" })).find((x) => x.order_id === order.id && x.summary.includes("because the payer pasted its hash"));
    expect(flagged?.kind).toBe("payment");
    expect((await listEscalations(env.DB)).some((x) => x.order_id === order.id && x.summary.includes("Book the printer"))).toBe(false);
  });

  it("tells the owner once to book the printer when a transfer completes the deposit", async () => {
    const { order, req } = await pendingDeposit(4343);
    await setLastBlock(1300);
    const paid = usdcLog(1305, req.amount_units, 14);
    await runWatcher(env, { rpc: fakeRpc(1340, [paid]).rpc, telegram: silent });
    await runWatcher(env, { rpc: fakeRpc(1340).rpc, telegram: silent });
    const book = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.summary.includes("Book the printer"));
    expect(book).toHaveLength(1);
    expect(book[0].kind).toBe("payment");
    expect(book[0].summary).toContain(`Order ${order.id}: deposit paid (257.504343 USDC, tx ${paid.transactionHash}). Book the printer: cost 1000.00 PLN gross (quote #${req.quote_id}).`);
    expect(book[0].summary).toMatch(/ Printer cost obligation #\d+: 257\.500000 USDC to the payout account\.$/);
    // The treasury pays this one: acknowledging the notice must not settle it.
    expect(JSON.parse(book[0].payload_json).manual).toBeUndefined();
  });

  it("settles a printer cost the owner pays by hand once they acknowledge its notice", async () => {
    const { order, req } = await pendingDeposit(4848, { currency: "EUR" });
    await setLastBlock(1600);
    const eurc: RawLog = {
      address: env.EURC_ADDRESS, topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(TO)],
      data: "0x" + BigInt(req.amount_units).toString(16).padStart(64, "0"),
      blockNumber: "0x" + (1605).toString(16), transactionHash: "0x" + (26).toString(16).padStart(64, "0"), logIndex: "0x1",
    };
    await runWatcher(env, { rpc: fakeRpc(1640, [eurc]).rpc, telegram: silent });
    const ob = (await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).first<ObligationRow>())!;
    expect(ob).toMatchObject({ status: "escalated", token: "EURC", note: "only USDC payouts are configured" });
    const notice = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "payment" && x.summary.includes("Book the printer"))!;
    expect(JSON.parse(notice.payload_json)).toMatchObject({ obligationId: ob.id, manual: true });
    const ack = new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text: `/approve ${notice.id}` } }),
    });
    expect((await handleTelegram(ack, env, { telegram: silent })).status).toBe(200);
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "settled", approved_by: "owner" });
    // Nothing for the treasury to do: it isn't told.
    await runInDurableObject(await getAgentByName(env.TreasuryAgent, "treasury"), async (agent: TreasuryAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).not.toContain(`escalation #${notice.id} `);
    });
  });

  it("opens a printer-cost obligation when a USDC deposit completes, and a refund obligation for a surplus", async () => {
    const { order, req } = await pendingDeposit(9292);
    await addClaim(env.DB, req.id, usdcLog(4105, 300_000_000, 9292).transactionHash);
    await setLastBlock(4100);
    await runWatcher(env, { rpc: fakeRpc(4140, [usdcLog(4105, 300_000_000, 9292)]).rpc, telegram: silent });
    const obs = (await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ?").bind(order.id).all<ObligationRow>()).results;
    const cost = obs.find((o) => o.kind === "printer_cost")!;
    expect(cost).toMatchObject({ token: "USDC", amount_units: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", status: "open" });
    const refund = obs.find((o) => o.kind === "refund")!;
    expect(refund.status).toBe("escalated");
    expect(refund.destination).toBe("0x2222222222222222222222222222222222222222");
    const approval = (await listEscalations(env.DB)).find((e) => e.order_id === order.id && e.kind === "approval");
    expect(JSON.parse(approval!.payload_json).obligationId).toBe(refund.id);
  });

  it("still reports a deposit once when the treasury config is invalid, and escalates the printer cost", async () => {
    const { order, stub, req } = await pendingDeposit(9494);
    await setLastBlock(4300);
    const bad = ({ ...env, TREASURY_DAILY_USDC: "1,500" as string }) as unknown as Env;
    const log = usdcLog(4305, req.amount_units, 9494);
    await runWatcher(bad, { rpc: fakeRpc(4340, [log]).rpc, telegram: silent });
    await runWatcher(bad, { rpc: fakeRpc(4340).rpc, telegram: silent });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text);
      expect(inbox.filter((t) => t.includes("Payment received on Arc"))).toHaveLength(1);
    });
    const obs = (await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).all<ObligationRow>()).results;
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ status: "escalated", amount_units: 257_500_000, note: 'treasury config is invalid (TREASURY_DAILY_USDC must be a non-negative number, got "1,500")' });
    const book = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.summary.includes("Book the printer"));
    expect(book).toHaveLength(1);
    expect(book[0].summary).toContain("The treasury agent can't move it (treasury config is invalid (TREASURY_DAILY_USDC");
    expect(book[0].summary).toContain("pay from the wallet by hand");
  });

  it("uses the default FX buffer for the printer cost when the order policy is invalid", async () => {
    const { order, req } = await pendingDeposit(9393);
    await setLastBlock(4200);
    const bad = ({ ...env, POLICY_FX_BUFFER: "lots" as string }) as unknown as Env;
    await runWatcher(bad, { rpc: fakeRpc(4240, [usdcLog(4205, req.amount_units, 9393)]).rpc, telegram: silent });
    const ob = await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).first<ObligationRow>();
    // 1000 PLN at 4 PLN/USD with the default 3% buffer.
    expect(ob).toMatchObject({ status: "escalated", amount_units: 257_500_000, note: 'treasury config is invalid (POLICY_FX_BUFFER must be a non-negative number, got "lots")' });
  });

  it("escalates the printer cost for manual payment when PAYOUT_ADDRESS is not set", async () => {
    const { order, req } = await pendingDeposit(9595);
    await setLastBlock(4400);
    await runWatcher(({ ...env, PAYOUT_ADDRESS: "" }) as Env, { rpc: fakeRpc(4440, [usdcLog(4405, req.amount_units, 9595)]).rpc, telegram: silent });
    const ob = await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'printer_cost'").bind(order.id).first<ObligationRow>();
    expect(ob).toMatchObject({ status: "escalated", note: "PAYOUT_ADDRESS is not set" });
    const e = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "payment" && x.summary.includes("Book the printer"));
    expect(e?.summary).toContain("pay from the wallet by hand");
  });

  it("asks for a refund address when the overpayment came from the zero address (a bridge mint)", async () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const { order, req } = await pendingDeposit(9696);
    const minted: RawLog = { ...usdcLog(4505, 300_000_000, 9696), topics: [TRANSFER_TOPIC, addressTopic(ZERO), addressTopic(TO)] };
    await addClaim(env.DB, req.id, minted.transactionHash);
    await setLastBlock(4500);
    await runWatcher(env, { rpc: fakeRpc(4540, [minted]).rpc, telegram: silent });
    const refund = await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? AND kind = 'refund'").bind(order.id).first<ObligationRow>();
    expect(refund).toMatchObject({ status: "escalated", destination: ZERO, note: "sender is the zero address (a bridge mint)" });
    const e = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "approval" && x.summary.includes("overpaid"));
    expect(e?.summary).toContain(`Order ${order.id} overpaid by 42.490304 USDC`);
    expect(e?.summary).toContain(`refund obligation #${refund!.id}`);
    expect(e?.summary).toContain("The sender is the zero address (a bridge mint): ask the payer for a refund address and refund by hand, then reject.");
    expect(e?.summary).not.toContain(`Refund it to ${ZERO}`);
  });

  it("escalates an overpayment", async () => {
    const { order, req } = await pendingDeposit(6161);
    await setLastBlock(400);
    const big = usdcLog(405, 300_000_000, 4);
    await addClaim(env.DB, req.id, big.transactionHash);
    await runWatcher(env, { rpc: fakeRpc(440, [big]).rpc, telegram: silent });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.kind === "approval" && x.order_id === order.id && x.summary.includes("overpaid"));
    expect(e?.summary).toContain(`Order ${order.id} overpaid by 42.493839 USDC`);
  });

  it("retries notifications that failed", async () => {
    const { order, stub, req } = await pendingDeposit(7171);
    await setLastBlock(600);
    const paid = usdcLog(605, req.amount_units, 5);
    const broken = ({ ...env, OrderAgent: { idFromName() { throw new Error("agent unavailable"); } } }) as unknown as Env;
    const inbox = () => runInDurableObject(stub, async (agent: OrderAgent) => agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n"));
    const unnotified = async () => (await listUnnotified(env.DB)).some((t) => t.tx_hash === paid.transactionHash);
    await runWatcher(broken, { rpc: fakeRpc(640, [paid]).rpc, telegram: silent });
    expect((await env.DB.prepare("SELECT status FROM payment_requests WHERE id = ?").bind(req.id).first<{ status: string }>())?.status).toBe("paid");
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
    expect(await unnotified()).toBe(true);
    expect(await inbox()).not.toContain("Payment received");
    await runWatcher(env, { rpc: fakeRpc(640).rpc, telegram: silent });
    expect(await inbox()).toContain("Payment received");
    expect(await unnotified()).toBe(false);
  });

  it("gives up once after ten failed notifications and raises a system escalation", async () => {
    const { order, req } = await pendingDeposit(7272);
    await setLastBlock(650);
    const paid = usdcLog(655, req.amount_units, 8);
    const broken = ({ ...env, OrderAgent: { idFromName() { throw new Error("agent unavailable"); } } }) as unknown as Env;
    await runWatcher(broken, { rpc: fakeRpc(690, [paid]).rpc, telegram: silent });
    await env.DB.prepare("UPDATE transfers SET notify_attempts = 9 WHERE tx_hash = ?").bind(paid.transactionHash).run();
    await runWatcher(broken, { rpc: fakeRpc(690).rpc, telegram: silent });
    const found = (await listEscalations(env.DB, { status: "open" })).filter((x) => x.kind === "system" && x.summary.includes(`Payment notification keeps failing for tx ${paid.transactionHash}`));
    expect(found).toHaveLength(1);
    expect(found[0].order_id).toBe(order.id);
    await runWatcher(broken, { rpc: fakeRpc(690).rpc, telegram: silent });
    expect((await listUnnotified(env.DB)).some((t) => t.tx_hash === paid.transactionHash)).toBe(false);
    expect((await listEscalations(env.DB, { status: "open" })).filter((x) => x.summary.includes("keeps failing for tx " + paid.transactionHash))).toHaveLength(1);
  });

  it("reports each credit from its own point in time", async () => {
    const { order, stub, req } = await pendingDeposit(6262);
    await setLastBlock(900);
    const a = usdcLog(905, req.amount_units - 57_500_000, 9);
    const b = usdcLog(906, 300_000_000, 10);
    await addClaim(env.DB, req.id, b.transactionHash);
    await runWatcher(env, { rpc: fakeRpc(940, [a, b]).rpc, telegram: silent });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n");
      expect(inbox).toContain("Still due");
    });
    const over = (await listEscalations(env.DB, { status: "open" })).filter((x) => x.order_id === order.id && x.summary.includes("overpaid"));
    expect(over).toHaveLength(1);
    expect(over[0].summary).toContain("overpaid by 242.500000");
  });

  it("notifies already-recorded transfers even when the RPC is down", async () => {
    const { req } = await pendingDeposit(7373);
    await setLastBlock(950);
    const paid = usdcLog(955, req.amount_units, 11);
    const broken = ({ ...env, OrderAgent: { idFromName() { throw new Error("agent unavailable"); } } }) as unknown as Env;
    await runWatcher(broken, { rpc: fakeRpc(990, [paid]).rpc, telegram: silent });
    const failing: RpcClient = { async chainId() { return 5042; }, async blockNumber() { return 1100; }, async getLogs() { throw new Error("HTTP 503"); } };
    await expect(runWatcher(env, { rpc: failing, telegram: silent })).rejects.toThrow("HTTP 503");
    expect((await listUnnotified(env.DB)).some((t) => t.tx_hash === paid.transactionHash)).toBe(false);
  });

  it("skips an unreadable log, tells the owner, and records the good one", async () => {
    const { req } = await pendingDeposit(7474);
    await setLastBlock(1200);
    const good = usdcLog(1205, req.amount_units, 12);
    const bad = { ...usdcLog(1205, 1, 13), data: "0xzz" };
    const r = await runWatcher(env, { rpc: fakeRpc(1240, [bad, good]).rpc, telegram: silent });
    expect(r?.outcomes.map((o) => o.kind)).toEqual(["matched"]);
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.kind === "system" && x.summary.includes(`Skipped an unreadable Transfer log (tx ${bad.transactionHash}`));
    expect(e?.order_id).toBeNull();
  });

  it("runs one at a time", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('lock_until', ?)").bind(String(Date.now() + 60_000)).run();
    try {
      let called = false;
      const rpc: RpcClient = { async chainId() { called = true; return 5042; }, async blockNumber() { called = true; return 1; }, async getLogs() { return []; } };
      expect(await runWatcher(env, { rpc, telegram: silent })).toBeNull();
      expect(called).toBe(false);
    } finally {
      await env.DB.prepare("UPDATE watcher_state SET value = '0' WHERE key = 'lock_until'").run();
    }
  });

  it("completes an order still in quoted", async () => {
    const { order, req } = await pendingDeposit(8181, { pending: false });
    await setOrderStatus(env.DB, order.id, ["draft"], "quoted");
    await setLastBlock(700);
    await runWatcher(env, { rpc: fakeRpc(740, [usdcLog(705, req.amount_units, 6)]).rpc, telegram: silent });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
  });

  it("only logs unmatched transfers under one token", async () => {
    expect(MIN_ESCALATION_UNITS).toBe(1_000_000);
    await setLastBlock(800);
    const dust = usdcLog(805, 5_000, 7);
    const small = usdcLog(806, 999_999, 20);
    const one = usdcLog(807, 1_000_000, 21);
    await runWatcher(env, { rpc: fakeRpc(840, [dust, small, one]).rpc, telegram: silent });
    const summaries = (await listEscalations(env.DB)).map((x) => x.summary);
    expect(summaries.some((x) => x.includes(dust.transactionHash))).toBe(false);
    expect(summaries.some((x) => x.includes(small.transactionHash))).toBe(false);
    expect(summaries.some((x) => x.includes(`Unmatched transfer: 1.000000 USDC`) && x.includes(one.transactionHash))).toBe(true);
    const row = await env.DB.prepare("SELECT notified_at FROM transfers WHERE tx_hash = ?").bind(small.transactionHash).first<{ notified_at: string | null }>();
    expect(row?.notified_at).not.toBeNull();
  });

  it("credits an EURC deposit paid from the EURC contract", async () => {
    const { order, stub, req } = await pendingDeposit(4747, { currency: "EUR" });
    expect(req.token).toBe("EURC");
    await setLastBlock(1500);
    const eurc: RawLog = {
      address: env.EURC_ADDRESS, topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(TO)],
      data: "0x" + BigInt(req.amount_units).toString(16).padStart(64, "0"),
      blockNumber: "0x" + (1505).toString(16), transactionHash: "0x" + (22).toString(16).padStart(64, "0"), logIndex: "0x1",
    };
    const r = await runWatcher(env, { rpc: fakeRpc(1540, [eurc]).rpc, telegram: silent });
    expect(r?.outcomes.map((o) => o.kind)).toEqual(["matched"]);
    expect((await env.DB.prepare("SELECT status, paid_units FROM payment_requests WHERE id = ?").bind(req.id).first())).toEqual({ status: "paid", paid_units: req.amount_units });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n")).toContain(`Payment received on Arc: 257.504747 EURC for deposit request #${req.id}`);
    });
  });

  it("does nothing without a receiving address, and keeps its place when the RPC fails", async () => {
    const closed = ({ ...env, RECEIVING_ADDRESS: "" }) as Env;
    expect(await runWatcher(closed, { rpc: fakeRpc(1).rpc })).toBeNull();
    await setLastBlock(500);
    const failing: RpcClient = { async chainId() { return 5042; }, async blockNumber() { return 600; }, async getLogs() { throw new Error("HTTP 503"); } };
    await expect(runWatcher(env, { rpc: failing, telegram: silent })).rejects.toThrow("HTTP 503");
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe("500");
  });

  it("stops starting chunks after two minutes of a run", async () => {
    await setLastBlock(20_000);
    try {
      const { rpc, calls } = fakeRpc(40_030);
      let t = 0;
      const clock = () => { const now = t; t += 50_000; return now; }; // start 0; checks at 50 s, 100 s, then 150 s stops
      const r = await runWatcher(env, { rpc, telegram: silent, clock });
      expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([[20_001, 25_000], [25_001, 30_000]]);
      expect(r).toMatchObject({ from: 20_001, to: 30_000 });
      expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe("30000");
    } finally {
      await setLastBlock(2200);
    }
  });

  it("ignores logs the RPC returns for another address or outside the requested blocks", async () => {
    await setLastBlock(3000);
    const elsewhere = { ...usdcLog(3010, 77_000_000, 18), topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic("0x3333333333333333333333333333333333333333")] };
    const early = usdcLog(50, 77_000_000, 19);
    const rpc: RpcClient = { async chainId() { return 5042; }, async blockNumber() { return 3040; }, async getLogs() { return [elsewhere, early]; } };
    const r = await runWatcher(env, { rpc, telegram: silent });
    expect(r?.outcomes).toEqual([]);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM transfers WHERE tx_hash IN (?, ?)").bind(elsewhere.transactionHash, early.transactionHash).first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("re-reads the head on the node it fell back to and never records past it", async () => {
    await setLastBlock(3400);
    const kept = usdcLog(3450, 77_000_000, 23);
    const beyond = usdcLog(3500, 77_000_000, 24);
    const calls: { fromBlock: number; toBlock: number }[] = [];
    const heads = [3540, 3520]; // the fallback node is 20 blocks behind the first
    let switched = true;
    const rpc: RpcClient = {
      async chainId() { return 5042; },
      async blockNumber() { return heads.shift() ?? 3520; },
      async getLogs(f) {
        calls.push({ fromBlock: f.fromBlock, toBlock: f.toBlock });
        return [kept, beyond].filter((l) => Number(l.blockNumber) >= f.fromBlock && Number(l.blockNumber) <= f.toBlock);
      },
      takeSwitched() { const was = switched; switched = false; return was; },
    };
    const r = await runWatcher(env, { rpc, telegram: silent });
    expect(calls).toEqual([{ fromBlock: 3401, toBlock: 3510 }, { fromBlock: 3401, toBlock: 3490 }]);
    expect(r).toMatchObject({ from: 3401, to: 3490 });
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe("3490");
    const stored = (await env.DB.prepare("SELECT tx_hash FROM transfers WHERE tx_hash IN (?, ?)").bind(kept.transactionHash, beyond.transactionHash).all<{ tx_hash: string }>()).results;
    expect(stored.map((x) => x.tx_hash)).toEqual([kept.transactionHash]);
  });

  it("discards logs from a fallback node on another chain", async () => {
    await setLastBlock(3600);
    const chains = [5042, 5042002]; // the run starts on the right chain; the fallback it switches to is not
    let switched = true;
    const rpc: RpcClient = {
      async chainId() { return chains.shift() ?? 5042002; },
      async blockNumber() { return 3700; },
      async getLogs() { return [usdcLog(3650, 77_000_000, 25)]; },
      takeSwitched() { const was = switched; switched = false; return was; },
    };
    await expect(runWatcher(env, { rpc, telegram: silent })).rejects.toThrow("fallback RPC is on another chain");
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe("3600");
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM transfers WHERE tx_hash = ?").bind(usdcLog(3650, 77_000_000, 25).transactionHash).first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  describe("chain binding", () => {
    const state = async (key: string) => (await env.DB.prepare("SELECT value FROM watcher_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
    const systemAlerts = async (text: string) => (await listEscalations(env.DB)).filter((x) => x.kind === "system" && x.order_id === null && x.summary === text);

    it("stops on an RPC for another chain, alerts once, and re-arms once the chain matches", async () => {
      await setLastBlock(2000);
      const text = "RPC chain 5042002 does not match ARC_CHAIN_ID 5042; the payment watcher is stopped.";
      const wrong = fakeRpc(2100, [usdcLog(2050, 77_000_000, 16)], 5042002);
      expect(await runWatcher(env, { rpc: wrong.rpc, telegram: silent })).toBeNull();
      expect(await runWatcher(env, { rpc: wrong.rpc, telegram: silent })).toBeNull();
      expect(wrong.calls).toHaveLength(0);
      expect(await systemAlerts(text)).toHaveLength(1);
      expect(await state("last_block")).toBe("2000");
      await runWatcher(env, { rpc: fakeRpc(2030).rpc, telegram: silent });
      expect(await state("alert_chain")).toBeNull();
      await runWatcher(env, { rpc: wrong.rpc, telegram: silent });
      expect(await systemAlerts(text)).toHaveLength(2);
    });

    it("stores the chain next to the cursor and refuses state from another chain", async () => {
      await setLastBlock(2100);
      await runWatcher(env, { rpc: fakeRpc(2130).rpc, telegram: silent });
      expect(await state("chain_id")).toBe("5042");
      await env.DB.prepare("UPDATE watcher_state SET value = '5042002' WHERE key = 'chain_id'").run();
      try {
        const rpc = fakeRpc(2200, [usdcLog(2150, 77_000_000, 17)]);
        expect(await runWatcher(env, { rpc: rpc.rpc, telegram: silent })).toBeNull();
        expect(await runWatcher(env, { rpc: rpc.rpc, telegram: silent })).toBeNull();
        expect(rpc.calls).toHaveLength(0);
        expect(await systemAlerts("watcher_state belongs to chain 5042002; clear it before watching chain 5042.")).toHaveLength(1);
        expect(await state("last_block")).toBe("2100");
      } finally {
        await env.DB.prepare("UPDATE watcher_state SET value = '5042' WHERE key = 'chain_id'").run();
      }
    });

    it("stops when the cursor is far ahead of the chain head", async () => {
      await setLastBlock(9_000);
      try {
        const rpc = fakeRpc(7_000);
        expect(await runWatcher(env, { rpc: rpc.rpc, telegram: silent })).toBeNull();
        expect(await runWatcher(env, { rpc: rpc.rpc, telegram: silent })).toBeNull();
        expect(rpc.calls).toHaveLength(0);
        expect(await systemAlerts("last_block is ahead of the chain head; the watcher state looks stale (a testnet cursor?).")).toHaveLength(1);
        expect(await state("last_block")).toBe("9000");
      } finally {
        await setLastBlock(2200);
      }
    });
  });
});

describe("partner printers paid in two milestones", () => {
  const VADDR = "0x" + "ab".repeat(20);
  const PAYOUT = "0x3333333333333333333333333333333333333333";
  let vendorSeq = 0;
  async function addVendor(o: { status: VendorStatus; name?: string; address?: string | null; chain?: string | null }): Promise<number> {
    const at = "2099-01-01T10:00:00.000Z";
    const res = await env.DB.prepare(
      "INSERT INTO vendors (name, city, country, methods, status, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES (?, 'Warsaw', 'PL', '[\"screen\"]', ?, ?, ?, ?, ?, ?)",
    ).bind(o.name ?? "Drukarnia Partner", o.status, o.address ?? null, o.chain ?? null, `w:${++vendorSeq}`, at, at).run();
    return res.meta.last_row_id as number;
  }
  const partner = (name = "Drukarnia Partner") => addVendor({ status: "partner", name, address: VADDR, chain: "BASE" });
  const propose = (orderId: number, vendorId: number) =>
    proposeVendorJob(env.DB, { orderId, vendorId, deliverBy: "2099-10-08T15:00:00.000Z", currency: "PLN", cents: 100_000 });
  const obligationsOf = async (orderId: number) =>
    (await env.DB.prepare("SELECT * FROM obligations WHERE order_id = ? ORDER BY id").bind(orderId).all<ObligationRow>()).results;
  const treasuryInbox = async () => runInDurableObject(await getAgentByName(env.TreasuryAgent, "treasury"), async (agent: TreasuryAgent) =>
    agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text));

  it("records the printer payment the owner makes by hand, once, at the printer's own currency and price", async () => {
    const { order, req } = await pendingDeposit(5757);
    const v = (await env.DB.prepare("INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES ('Druk', 'Warsaw', 'PL', '[]', 'screened', 'w:sp', 'x', 'x') RETURNING id").first<{ id: number }>())!.id;
    await proposeVendorJob(env.DB, { orderId: order.id, vendorId: v, deliverBy: "2099-10-08T15:00:00.000Z", currency: "EUR", cents: 48_000 });
    await setLastBlock(8100);
    const log = usdcLog(8105, req.amount_units, 5757);
    await runWatcher(env, { rpc: fakeRpc(8140, [log]).rpc, telegram: silent });
    expect(await supplierPaymentForOrder(env.DB, order.id)).toMatchObject({ vendor_id: v, currency: "EUR", amount_cents: 48_000, status: "due" });
    // Without a printer job: the quote's PLN cost.
    const b = await pendingDeposit(5858);
    await setLastBlock(8200);
    await runWatcher(env, { rpc: fakeRpc(8240, [usdcLog(8205, b.req.amount_units, 5858)]).rpc, telegram: silent });
    expect(await supplierPaymentForOrder(env.DB, b.order.id)).toMatchObject({ vendor_id: null, currency: "PLN", amount_cents: 100_000 });
  });

  it("pays a partner printer directly: half now, the rest (waiting) after /printed, adding up to the printer's cost without the FX buffer", async () => {
    const { order, req } = await pendingDeposit(3131);
    // A rate that makes the printer cost odd: 1000 PLN at 7 PLN per USDC is 142.857143 USDC.
    await env.DB.prepare("UPDATE quotes SET pln_per_unit = 7 WHERE id = ?").bind(req.quote_id).run();
    const v = await partner();
    await propose(order.id, v);
    await setLastBlock(5100);
    const paid = usdcLog(5105, req.amount_units, 3131);
    const buffered = ({ ...env, POLICY_FX_BUFFER: "0.05" }) as unknown as Env;
    await runWatcher(buffered, { rpc: fakeRpc(5140, [paid]).rpc, telegram: silent });
    const quote = (await getQuote(env.DB, req.quote_id))!;
    // The printer is paid its cost; the FX buffer stays in the wallet as margin.
    const total = printerCostUnits(quote, 0);
    expect(total).toBe(142_857_143);
    expect(printerCostUnits(quote, 0.05)).toBeGreaterThan(total);
    const obs = await obligationsOf(order.id);
    expect(obs).toHaveLength(2);
    const [m1, m2] = obs;
    expect(m1).toMatchObject({
      kind: "printer_cost", token: "USDC", amount_units: 71_428_572, destination: VADDR, chain: "BASE", status: "open", vendor_id: v,
      source_ref: `printer_cost:quote:${req.quote_id}:m1`,
    });
    expect(m2).toMatchObject({
      kind: "printer_cost", token: "USDC", amount_units: 71_428_571, destination: VADDR, chain: "BASE", status: "waiting", vendor_id: v,
      source_ref: `printer_cost:quote:${req.quote_id}:m2`,
    });
    expect(m1.amount_units + m2.amount_units).toBe(total);
    // The treasury pays this printer: there is no hand payment.
    expect(await supplierPaymentForOrder(env.DB, order.id)).toBeNull();
    // Nothing goes to the owner's payout account.
    expect(obs.some((o) => o.destination === PAYOUT || o.source_ref === `printer_cost:quote:${req.quote_id}`)).toBe(false);
    // The margin counts the whole printer cost once.
    expect((await orderMargin(env.DB, order.id))?.printerCostUnits).toBe(total);
    const job = await vendorJobFor(env.DB, order.id);
    expect(job).toMatchObject({ vendor_id: v, status: "booked" });
    expect(job?.booked_at).not.toBeNull();
    const notices = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.summary.includes("deposit paid"));
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("payment");
    expect(notices[0].summary).toBe(
      `Order ${order.id}: deposit paid (${formatUnits(req.amount_units)} USDC, tx ${paid.transactionHash}). Printer #${v} Drukarnia Partner (partner) is paid by the treasury in two milestones: #${m1.id} (71.428572 USDC) now, #${m2.id} (71.428571 USDC) after /printed. Send the job to the printer with the files from the order page.`,
    );
    expect(notices[0].summary).not.toContain("Book the printer");
    // Acknowledging the notice settles nothing: the treasury pays the milestones.
    expect(JSON.parse(notices[0].payload_json)).toMatchObject({ obligationId: m1.id });
    expect(JSON.parse(notices[0].payload_json).manual).toBeUndefined();
    const told = (await treasuryInbox()).filter((x) => x.startsWith(`Order ${order.id}: deposit completed`));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`obligation #${m1.id}`);
    expect(told[0]).toContain(`obligation #${m2.id}`);
    expect(told[0]).toContain(`printer #${v}`);
    // The treasury's events carry no printer names (its reasons are public).
    expect(told[0]).not.toContain("Drukarnia");
  });

  it("escalates the first milestone of a late deposit with the late approval; the second stays waiting", async () => {
    const due = new Date(Date.now() - 3_600_000);
    const { order, req } = await pendingDeposit(3232, { dueBy: due });
    const v = await partner("Drukarnia Late");
    await propose(order.id, v);
    await setLastBlock(5200);
    await runWatcher(env, { rpc: fakeRpc(5240, [usdcLog(5205, req.amount_units, 3232)]).rpc, telegram: silent });
    const [m1, m2] = await obligationsOf(order.id);
    expect(m1).toMatchObject({ amount_units: 125_000_000, status: "escalated", vendor_id: v, destination: VADDR, chain: "BASE" });
    expect(m2).toMatchObject({ amount_units: 125_000_000, status: "waiting", vendor_id: v });
    const approvals = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].summary).toContain(`Order ${order.id}: deposit paid LATE (due ${warsawTime(due)} Warsaw time)`);
    expect(approvals[0].summary).toContain(`Approve if printing is still possible: the treasury pays printer #${v} in two milestones (#${m1.id}: 125.000000 USDC now, #${m2.id}: 125.000000 USDC after /printed). Reject to handle the printer yourself: neither milestone is then paid by the treasury.`);
    // The owner's decision forwards this summary to the treasury, whose reasons are public: no printer name.
    expect(approvals[0].summary).not.toContain("Drukarnia");
    expect(JSON.parse(approvals[0].payload_json).obligationId).toBe(m1.id);
    expect((await listEscalations(env.DB)).some((x) => x.order_id === order.id && x.kind === "payment" && x.summary.includes("deposit paid"))).toBe(false);
    expect((await vendorJobFor(env.DB, order.id))?.status).toBe("booked");
    const ack = new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text: `/approve ${approvals[0].id}` } }),
    });
    await handleTelegram(ack, env, { telegram: silent });
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "approved", approved_by: "owner" });
    expect(await getObligation(env.DB, m2.id)).toMatchObject({ status: "waiting", approved_by: null });
    expect((await treasuryInbox()).some((x) => x.includes(`Owner decision on escalation #${approvals[0].id} `))).toBe(true);
    expect((await treasuryInbox()).join("\n")).not.toContain("Drukarnia");
  });

  it("rejecting a late deposit's approval settles both milestones, so /printed then releases nothing", async () => {
    const due = new Date(Date.now() - 3_600_000);
    const { order, req } = await pendingDeposit(4141, { dueBy: due });
    const v = await partner("Drukarnia Rejected");
    await propose(order.id, v);
    await setLastBlock(6000);
    await runWatcher(env, { rpc: fakeRpc(6040, [usdcLog(6005, req.amount_units, 4141)]).rpc, telegram: silent });
    const [m1, m2] = await obligationsOf(order.id);
    const approval = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "approval")!;
    const owner = (text: string) => new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text } }),
    });
    await handleTelegram(owner(`/reject ${approval.id}`), env, { telegram: silent });
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "settled" });
    expect(await getObligation(env.DB, m2.id)).toMatchObject({ status: "settled", approved_by: "owner" });
    expect((await treasuryInbox()).join("\n")).not.toContain("Drukarnia");
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(req.quote_id).run();
    const sent: string[] = [];
    await handleTelegram(owner(`/printed ${order.id}`), env, { telegram: { async send(_c, text) { sent.push(text); return 1; }, async answerCallback() {} } });
    expect(sent[0]).toMatch(new RegExp(`^Order ${order.id}: printed; balance request #\\d+ for .* is on the order page\\.$`));
    expect((await getObligation(env.DB, m2.id))?.status).toBe("settled");
    expect((await treasuryInbox()).some((x) => x.includes(`milestone obligation #${m2.id} `))).toBe(false);
  });

  it("rejecting a late deposit after /printed also settles the released milestone, so nothing is paid", async () => {
    const due = new Date(Date.now() - 3_600_000);
    const { order, req } = await pendingDeposit(4646, { dueBy: due });
    const v = await partner("Drukarnia Printed Early");
    await propose(order.id, v);
    await setLastBlock(6200);
    await runWatcher(env, { rpc: fakeRpc(6240, [usdcLog(6205, req.amount_units, 4646)]).rpc, telegram: silent });
    const [m1, m2] = await obligationsOf(order.id);
    const approval = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "approval")!;
    const owner = (text: string) => new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text } }),
    });
    // The owner reports printing before deciding the late deposit: milestone 2 opens.
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(req.quote_id).run();
    await handleTelegram(owner(`/printed ${order.id}`), env, { telegram: silent });
    expect((await getObligation(env.DB, m2.id))?.status).toBe("open");
    await handleTelegram(owner(`/reject ${approval.id}`), env, { telegram: silent });
    expect((await getObligation(env.DB, m1.id))?.status).toBe("settled");
    expect(await getObligation(env.DB, m2.id)).toMatchObject({ status: "settled", approved_by: "owner" });
    const paid = await env.DB.prepare("SELECT COUNT(*) AS n FROM payouts WHERE obligation_id IN (?, ?)").bind(m1.id, m2.id).first<{ n: number }>();
    expect(paid?.n).toBe(0);
    expect((await treasuryInbox()).some((x) => x.includes(`milestone #${m2.id} settled too`))).toBe(true);
  });

  it("holds milestone 2 while a late deposit's milestone 1 waits for the owner; approving pays m1, then m2", async () => {
    const due = new Date(Date.now() - 3_600_000);
    const { order, req } = await pendingDeposit(4747, { dueBy: due });
    const v = await partner("Drukarnia Held");
    await propose(order.id, v);
    await setLastBlock(6300);
    await runWatcher(env, { rpc: fakeRpc(6340, [usdcLog(6305, req.amount_units, 4747)]).rpc, telegram: silent });
    const [m1, m2] = await obligationsOf(order.id);
    const approval = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.kind === "approval")!;
    const sent: string[] = [];
    const owner = (text: string) => handleTelegram(new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text } }),
    }), env, { telegram: { async send(_c, text) { sent.push(text); return 1; }, async answerCallback() {} } });
    // /printed before the owner decides the late deposit: m2 opens, but is held.
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(req.quote_id).run();
    await owner(`/printed ${order.id}`);
    expect((await getObligation(env.DB, m2.id))?.status).toBe("open");
    expect(sent[0]).toContain(`Printer #${v}'s milestone #${m2.id} (125.000000 USDC) is now due; the printer's second milestone is held until you decide #${approval.id}.`);
    expect((await treasuryInbox()).find((x) => x.includes(`milestone obligation #${m2.id} `))).toContain(`It is held while milestone #${m1.id} waits for the owner's decision.`);

    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    const turn = async (ids: number[]) => runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = silent;
      agent.rpcOverride = { ...fakeRpc(1).rpc, async erc20Balance() { return 10_000_000_000; } };
      agent.modelOverride = scriptedModel([...ids.map((id) => msg([toolUse("pay_obligation", { obligationId: id, reason: "the milestone is due" })], "tool_use")), msg([], "end_turn")]);
      await agent.processTurn();
    });
    const payoutsOf = async () => (await env.DB.prepare("SELECT obligation_id FROM payouts WHERE obligation_id IN (?, ?) ORDER BY id").bind(m1.id, m2.id).all<{ obligation_id: number }>()).results.map((p) => p.obligation_id);
    // Blocked, not escalated: the owner already has the question.
    await turn([m2.id]);
    expect(await payoutsOf()).toEqual([]);
    expect((await getObligation(env.DB, m2.id))?.status).toBe("open");
    const held = await env.DB.prepare("SELECT verdict, detail FROM treasury_decisions WHERE tool = 'pay_obligation' AND input_json LIKE ? ORDER BY id DESC").bind(`%"obligationId":${m2.id},%`).first<{ verdict: string; detail: string }>();
    expect(held).toEqual({ verdict: "block", detail: `milestone #${m1.id} waits for the owner's decision` });
    expect((await listEscalations(env.DB)).filter((x) => x.summary.startsWith("Treasury:") && x.summary.includes(`#${m2.id}`))).toEqual([]);

    await owner(`/approve ${approval.id}`);
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "approved", approved_by: "owner" });
    await turn([m1.id, m2.id]);
    expect(await payoutsOf()).toEqual([m1.id, m2.id]);
  });

  it("never records a milestone 2 of 0 units", async () => {
    // A first attempt recorded a milestone 1 that already covers the whole printer cost.
    const { order, req } = await pendingDeposit(4444);
    const v = await partner();
    await propose(order.id, v);
    const m1 = await createObligation(env.DB, {
      orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: VADDR, chain: "BASE",
      dueAt: new Date(), sourceRef: `printer_cost:quote:${req.quote_id}:m1`, vendorId: v,
    });
    await setLastBlock(6100);
    await runWatcher(env, { rpc: fakeRpc(6140, [usdcLog(6105, req.amount_units, 4444)]).rpc, telegram: silent });
    expect((await obligationsOf(order.id)).map((o) => o.id)).toEqual([m1.id]);
    const notice = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.summary.includes("deposit paid"))!;
    expect(notice.summary).toContain(`#${m1.id} (257.500000 USDC) now.`);
    expect(notice.summary).not.toContain("after /printed");
  });

  it("keeps the owner's single printer cost for a screened printer, and still books the job", async () => {
    const { order, req } = await pendingDeposit(3333);
    const v = await addVendor({ status: "screened", name: "Drukarnia Screened" });
    await propose(order.id, v);
    await setLastBlock(5300);
    const paid = usdcLog(5305, req.amount_units, 3333);
    await runWatcher(env, { rpc: fakeRpc(5340, [paid]).rpc, telegram: silent });
    const obs = await obligationsOf(order.id);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      kind: "printer_cost", amount_units: 257_500_000, destination: PAYOUT, chain: "MATIC", status: "open", vendor_id: null,
      source_ref: `printer_cost:quote:${req.quote_id}`,
    });
    const book = (await listEscalations(env.DB)).filter((x) => x.order_id === order.id && x.summary.includes("Book the printer"));
    expect(book).toHaveLength(1);
    expect(book[0].summary).toBe(`Order ${order.id}: deposit paid (257.503333 USDC, tx ${paid.transactionHash}). Book the printer: cost 1000.00 PLN gross (quote #${req.quote_id}). Printer cost obligation #${obs[0].id}: 257.500000 USDC to the payout account. Recorded printer: #${v} Drukarnia Screened (not paid by the treasury: it is screened, not a partner).`);
    expect((await vendorJobFor(env.DB, order.id))?.status).toBe("booked");
  });

  it("keeps the owner path for a partner without a payout, an EURC deposit, or an invalid treasury config", async () => {
    // A partner that has not registered where it is paid.
    const a = await pendingDeposit(3434);
    const noPayout = await addVendor({ status: "partner", name: "No Payout" });
    await propose(a.order.id, noPayout);
    await setLastBlock(5400);
    await runWatcher(env, { rpc: fakeRpc(5440, [usdcLog(5405, a.req.amount_units, 3434)]).rpc, telegram: silent });
    expect((await obligationsOf(a.order.id)).map((o) => [o.source_ref, o.destination, o.status, o.vendor_id])).toEqual([[`printer_cost:quote:${a.req.quote_id}`, PAYOUT, "open", null]]);
    expect((await vendorJobFor(env.DB, a.order.id))?.status).toBe("booked");
    const aNotice = (await listEscalations(env.DB)).find((x) => x.order_id === a.order.id && x.summary.includes("Book the printer"))!;
    expect(aNotice.summary).toMatch(new RegExp(` Recorded printer: #${noPayout} No Payout \\(not paid by the treasury: it has no registered payout address\\)\\.$`));

    // EURC: the treasury only pays USDC.
    const b = await pendingDeposit(3535, { currency: "EUR" });
    await propose(b.order.id, await partner());
    await setLastBlock(5500);
    const eurc: RawLog = {
      address: env.EURC_ADDRESS, topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(TO)],
      data: "0x" + BigInt(b.req.amount_units).toString(16).padStart(64, "0"),
      blockNumber: "0x" + (5505).toString(16), transactionHash: "0x" + (3535).toString(16).padStart(64, "0"), logIndex: "0x1",
    };
    await runWatcher(env, { rpc: fakeRpc(5540, [eurc]).rpc, telegram: silent });
    const eurcObs = await obligationsOf(b.order.id);
    expect(eurcObs).toHaveLength(1);
    // A partner with a payout: only the token keeps it off the treasury, which the notice already says.
    expect((await listEscalations(env.DB)).find((x) => x.order_id === b.order.id && x.summary.includes("deposit paid"))?.summary).not.toContain("Recorded printer");
    expect(eurcObs[0]).toMatchObject({ source_ref: `printer_cost:quote:${b.req.quote_id}`, token: "EURC", status: "escalated", vendor_id: null, note: "only USDC payouts are configured" });

    // Invalid treasury config: the printer cost can't be split safely.
    const c = await pendingDeposit(3636);
    await propose(c.order.id, await partner());
    await setLastBlock(5600);
    const bad = ({ ...env, TREASURY_DAILY_USDC: "1,500" as string }) as unknown as Env;
    await runWatcher(bad, { rpc: fakeRpc(5640, [usdcLog(5605, c.req.amount_units, 3636)]).rpc, telegram: silent });
    const badObs = await obligationsOf(c.order.id);
    expect(badObs).toHaveLength(1);
    // As before plan 5: the policy didn't load, so the owner pays it by hand.
    expect(badObs[0]).toMatchObject({ source_ref: `printer_cost:quote:${c.req.quote_id}`, destination: "", status: "escalated", vendor_id: null });
    expect(badObs[0].note).toMatch(/^treasury config is invalid/);
  });

  it("opens milestone 2 at once when the order was already printed before the deposit notice went through", async () => {
    const { order, req } = await pendingDeposit(3030);
    const v = await partner();
    await propose(order.id, v);
    // The first notice attempt failed after the order moved to deposit_paid; the owner sent /printed meanwhile.
    await setOrderStatus(env.DB, order.id, ["deposit_pending"], "balance_pending");
    await setLastBlock(5050);
    await runWatcher(env, { rpc: fakeRpc(5090, [usdcLog(5055, req.amount_units, 3030)]).rpc, telegram: silent });
    const [m1, m2] = await obligationsOf(order.id);
    expect(m1).toMatchObject({ status: "open", amount_units: 125_000_000 });
    expect(m2).toMatchObject({ status: "open", amount_units: 125_000_000, vendor_id: v });
    const notice = (await listEscalations(env.DB)).find((x) => x.order_id === order.id && x.summary.includes("deposit paid"))!;
    expect(notice.summary).toContain(`#${m1.id} (125.000000 USDC) now, #${m2.id} (125.000000 USDC) now too, as the job is already printed.`);
    const told = (await treasuryInbox()).find((x) => x.startsWith(`Order ${order.id}: deposit completed`))!;
    expect(told).toContain(`obligation #${m2.id} 125.000000 USDC now too, as the job is already printed (open)`);
  });

  it("creates no second set of milestones when the notification is retried", async () => {
    const { order, req } = await pendingDeposit(3737);
    const v = await partner();
    await propose(order.id, v);
    await setLastBlock(5700);
    const paid = usdcLog(5705, req.amount_units, 3737);
    await runWatcher(env, { rpc: fakeRpc(5740, [paid]).rpc, telegram: silent });
    const first = await obligationsOf(order.id);
    expect(first.map((o) => o.status)).toEqual(["open", "waiting"]);
    await env.DB.prepare("UPDATE transfers SET notified_at = NULL WHERE tx_hash = ?").bind(paid.transactionHash).run();
    await runWatcher(env, { rpc: fakeRpc(5740).rpc, telegram: silent });
    expect(await obligationsOf(order.id)).toEqual(first);
  });

  it("a retry keeps the path its first attempt took, so one printer cost is never recorded both ways", async () => {
    // The first attempt recorded the owner's printer cost; the printer became a partner with a payout since.
    const a = await pendingDeposit(3838);
    await propose(a.order.id, await partner());
    const owner = await createObligation(env.DB, {
      orderId: a.order.id, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: PAYOUT, chain: "MATIC",
      dueAt: new Date(), sourceRef: `printer_cost:quote:${a.req.quote_id}`,
    });
    await setLastBlock(5800);
    await runWatcher(env, { rpc: fakeRpc(5840, [usdcLog(5805, a.req.amount_units, 3838)]).rpc, telegram: silent });
    expect((await obligationsOf(a.order.id)).map((o) => o.id)).toEqual([owner.id]);

    // The first attempt recorded milestone 1 and stopped; the printer was paused (its payout cleared) since.
    const b = await pendingDeposit(3939);
    const v = await partner();
    await propose(b.order.id, v);
    const m1 = await createObligation(env.DB, {
      orderId: b.order.id, kind: "printer_cost", token: "USDC", amountUnits: 125_000_000, destination: VADDR, chain: "BASE",
      dueAt: new Date(), sourceRef: `printer_cost:quote:${b.req.quote_id}:m1`, vendorId: v,
    });
    await setVendorStatus(env.DB, v, "paused");
    await setLastBlock(5900);
    await runWatcher(env, { rpc: fakeRpc(5940, [usdcLog(5905, b.req.amount_units, 3939)]).rpc, telegram: silent });
    const obs = await obligationsOf(b.order.id);
    expect(obs.map((o) => o.source_ref)).toEqual([`printer_cost:quote:${b.req.quote_id}:m1`, `printer_cost:quote:${b.req.quote_id}:m2`]);
    expect(obs[0].id).toBe(m1.id);
    // Milestone 2 goes where milestone 1 goes, and the two add up to the printer cost.
    expect(obs[1]).toMatchObject({ amount_units: 125_000_000, destination: VADDR, chain: "BASE", vendor_id: v, status: "waiting" });
  });
});
