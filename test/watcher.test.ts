import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RawLog, type RpcClient } from "../src/arc";
import { getOrderById, setOrderStatus } from "../src/db";
import { listEscalations } from "../src/escalations";
import { addClaim, createPaymentRequest, listUnnotified } from "../src/payments";
import type { TelegramClient } from "../src/telegram";
import { CHUNK_BLOCKS, HEAD_LAG_BLOCKS, runWatcher } from "../src/watcher";
import { insertQuote, intakeFor, newOrderRow } from "./fixtures";

const TO = "0x1111111111111111111111111111111111111111";
const silent: TelegramClient = { async send() { return null; }, async answerCallback() {} };

function fakeRpc(latest: number, logs: RawLog[] = []) {
  const calls: { fromBlock: number; toBlock: number; address: string[]; topics: (string | null)[] }[] = [];
  const rpc: RpcClient = {
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

async function pendingDeposit(tag: number, opts: { init?: boolean; pending?: boolean } = {}) {
  const { order } = await newOrderRow();
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  if (opts.init !== false) await stub.init(order.id, intakeFor());
  const quoteId = await insertQuote(env.DB, order.id);
  if (opts.pending !== false) await setOrderStatus(env.DB, order.id, ["draft"], "deposit_pending");
  const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token: "USDC", cents: 25750 }, new Date(), () => tag);
  return { order, stub, req };
}

describe("runWatcher", () => {
  it("starts at the current block on its first run", async () => {
    await env.DB.prepare("DELETE FROM watcher_state").run();
    const { rpc, calls } = fakeRpc(1_000_000);
    expect(await runWatcher(env, { rpc, telegram: silent })).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe(String(1_000_000 - HEAD_LAG_BLOCKS));
  });

  it("reads both emitters for the receiving address in 5,000-block chunks", async () => {
    await setLastBlock(0);
    const { rpc, calls } = fakeRpc(12_005);
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
    const { rpc } = fakeRpc(110, [usdcLog(105, req.amount_units, 1)]);
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

  it("opens an escalation without an order for a transfer that matches nothing", async () => {
    await setLastBlock(200);
    const sent: string[] = [];
    const telegram: TelegramClient = { async send(_c, text) { sent.push(text); return 1; }, async answerCallback() {} };
    const { rpc } = fakeRpc(210, [usdcLog(205, 77_000_000, 2)]);
    await runWatcher(env, { rpc, telegram });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.kind === "payment" && x.summary.includes("77.000000 USDC"));
    expect(e?.order_id).toBeNull();
    expect(sent.some((s) => s.includes("Unmatched transfer: 77.000000 USDC"))).toBe(true);
  });

  it("credits a claimed transfer that first arrived unmatched", async () => {
    const { order, req } = await pendingDeposit(5151);
    await setLastBlock(300);
    const odd = usdcLog(305, 250_000_000, 3);
    await runWatcher(env, { rpc: fakeRpc(310, [odd]).rpc, telegram: silent });
    await addClaim(env.DB, req.id, odd.transactionHash);
    const r = await runWatcher(env, { rpc: fakeRpc(310).rpc, telegram: silent });
    expect(r?.outcomes.map((o) => o.kind)).toEqual(["matched"]);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_pending");
    const flagged = (await listEscalations(env.DB, { status: "open" })).find((x) => x.order_id === order.id && x.summary.includes("because the payer pasted its hash"));
    expect(flagged?.kind).toBe("payment");
  });

  it("escalates an overpayment", async () => {
    const { order, req } = await pendingDeposit(6161);
    await setLastBlock(400);
    const big = usdcLog(405, 300_000_000, 4);
    await addClaim(env.DB, req.id, big.transactionHash);
    await runWatcher(env, { rpc: fakeRpc(410, [big]).rpc, telegram: silent });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.kind === "payment" && x.order_id === order.id && x.summary.includes("overpaid"));
    expect(e?.summary).toContain(`Order ${order.id} overpaid by 42.493839 USDC`);
  });

  it("retries notifications that failed", async () => {
    const { order, stub, req } = await pendingDeposit(7171, { init: false });
    await setLastBlock(600);
    const paid = usdcLog(605, req.amount_units, 5);
    await runWatcher(env, { rpc: fakeRpc(620, [paid]).rpc, telegram: silent });
    expect((await env.DB.prepare("SELECT status FROM payment_requests WHERE id = ?").bind(req.id).first<{ status: string }>())?.status).toBe("paid");
    expect((await listUnnotified(env.DB)).some((t) => t.tx_hash === paid.transactionHash)).toBe(true);
    await stub.init(order.id, intakeFor());
    await runWatcher(env, { rpc: fakeRpc(620).rpc, telegram: silent });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((x) => x.text).join("\n");
      expect(inbox).toContain("Payment received");
    });
    expect((await listUnnotified(env.DB)).some((t) => t.tx_hash === paid.transactionHash)).toBe(false);
  });

  it("completes an order still in quoted", async () => {
    const { order, req } = await pendingDeposit(8181, { pending: false });
    await setOrderStatus(env.DB, order.id, ["draft"], "quoted");
    await setLastBlock(700);
    await runWatcher(env, { rpc: fakeRpc(720, [usdcLog(705, req.amount_units, 6)]).rpc, telegram: silent });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("deposit_paid");
  });

  it("does not escalate dust", async () => {
    await setLastBlock(800);
    await runWatcher(env, { rpc: fakeRpc(820, [usdcLog(805, 5_000, 7)]).rpc, telegram: silent });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.summary.includes("0.005000 USDC"));
    expect(e).toBeUndefined();
  });

  it("does nothing without a receiving address, and keeps its place when the RPC fails", async () => {
    const closed = ({ ...env, RECEIVING_ADDRESS: "" }) as Env;
    expect(await runWatcher(closed, { rpc: fakeRpc(1).rpc })).toBeNull();
    await setLastBlock(500);
    const failing: RpcClient = { async blockNumber() { return 600; }, async getLogs() { throw new Error("HTTP 503"); } };
    await expect(runWatcher(env, { rpc: failing, telegram: silent })).rejects.toThrow("HTTP 503");
    expect((await env.DB.prepare("SELECT value FROM watcher_state WHERE key = 'last_block'").first<{ value: string }>())?.value).toBe("500");
  });
});
