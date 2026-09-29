import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RawLog, type RpcClient } from "../src/arc";
import { getOrderById, setOrderStatus } from "../src/db";
import { listEscalations } from "../src/escalations";
import { addClaim, createPaymentRequest, listUnnotified } from "../src/payments";
import { warsawTime } from "../src/quote-text";
import { listObligations } from "../src/treasury";
import type { TelegramClient } from "../src/telegram";
import { CHUNK_BLOCKS, HEAD_LAG_BLOCKS, MIN_ESCALATION_UNITS, runWatcher } from "../src/watcher";
import { insertQuote, intakeFor, newOrderRow } from "./fixtures";

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
  });

  it("opens a printer-cost obligation when a USDC deposit completes, and a refund obligation for a surplus", async () => {
    const { order, req } = await pendingDeposit(9292);
    await addClaim(env.DB, req.id, usdcLog(4105, 300_000_000, 9292).transactionHash);
    await setLastBlock(4100);
    await runWatcher(env, { rpc: fakeRpc(4140, [usdcLog(4105, 300_000_000, 9292)]).rpc, telegram: silent });
    const obs = (await listObligations(env.DB, ["open", "escalated"], 200)).filter((o) => o.order_id === order.id);
    const cost = obs.find((o) => o.kind === "printer_cost")!;
    expect(cost).toMatchObject({ token: "USDC", amount_units: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", status: "open" });
    const refund = obs.find((o) => o.kind === "refund")!;
    expect(refund.status).toBe("escalated");
    expect(refund.destination).toBe("0x2222222222222222222222222222222222222222");
    const approval = (await listEscalations(env.DB)).find((e) => e.order_id === order.id && e.kind === "approval");
    expect(JSON.parse(approval!.payload_json).obligationId).toBe(refund.id);
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
