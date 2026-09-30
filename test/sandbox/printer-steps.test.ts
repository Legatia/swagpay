import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../../src/agent/order-agent";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, type RawLog, type RpcClient } from "../../src/arc";
import { handleApi } from "../../src/api";
import { getOrderById, setOrderStatus } from "../../src/db";
import { createPaymentRequest } from "../../src/payments";
import { SIMULATED, stepDelaySeconds } from "../../src/sandbox/printer";
import type { TelegramClient } from "../../src/telegram";
import { runWatcher } from "../../src/watcher";
import { insertQuote, intakeFor, newOrderRow } from "../fixtures";

const sandbox = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002" } as unknown as Env;
const silent: TelegramClient = { async send() { return null; }, async answerCallback() {} };

/** An initialised order whose agent runs as the sandbox (the DO keeps the worker's own env, so the test swaps it in). */
async function orderAgent(opts: { paid?: boolean; sandboxAgent?: boolean } = {}) {
  const { order, token } = await newOrderRow();
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intakeFor());
  if (opts.paid) {
    const quoteId = await insertQuote(env.DB, order.id);
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(quoteId).run();
    await env.DB.prepare("UPDATE orders SET status = 'deposit_paid' WHERE id = ?").bind(order.id).run();
  }
  if (opts.sandboxAgent !== false) await runInDurableObject(stub, async (agent: OrderAgent) => { (agent as unknown as { env: Env }).env = sandbox; });
  return { order, token, stub };
}

const schedules = (agent: OrderAgent) => agent.getSchedules().filter((s) => s.callback === "sandboxPrinterStep");
const thread = (agent: OrderAgent) => agent.sql<{ text: string }>`SELECT text FROM thread`.map((r) => r.text);

describe("simulated printer steps", () => {
  it("sandboxStartPrinter schedules accepted once", async () => {
    const { stub } = await orderAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.sandboxStartPrinter();
      await agent.sandboxStartPrinter();
      const s = schedules(agent);
      expect(s).toHaveLength(1);
      expect(s[0].payload).toEqual({ step: "accepted" });
      expect(Math.abs(s[0].time - (Date.now() / 1000 + stepDelaySeconds("accepted")))).toBeLessThan(5);
      expect(agent.sandboxPrinterState()).toMatchObject({ lastStep: null, nextStep: "accepted" });
    });
  });

  it("a step adds a SIMULATED thread line, records it and schedules the next", async () => {
    const { stub } = await orderAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.sandboxPrinterStep({ step: "accepted" });
      expect(thread(agent).some((t) => t.includes(SIMULATED) && t.includes("accepted"))).toBe(true);
      expect(schedules(agent).map((s) => s.payload)).toEqual([{ step: "proof" }]);
      expect(agent.sandboxPrinterState()).toMatchObject({ lastStep: "accepted", nextStep: "proof" });
    });
  });

  it("printed moves a deposit_paid order to balance_pending; shipped is last", async () => {
    const { order, stub } = await orderAgent({ paid: true });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await agent.sandboxPrinterStep({ step: "printed" });
      expect(schedules(agent).map((s) => s.payload)).toEqual([{ step: "shipped" }]);
      await agent.sandboxPrinterStep({ step: "shipped" });
      expect(schedules(agent).filter((s) => (s.payload as unknown as { step: string }).step !== "shipped")).toHaveLength(0);
      expect(agent.sandboxPrinterState().lastStep).toBe("shipped");
    });
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_pending");
  });

  it("sandboxSkip runs the pending step now and cancels its schedule", async () => {
    const { stub } = await orderAgent();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(await agent.sandboxSkip()).toBe("Nothing to skip.");
      await agent.sandboxStartPrinter();
      const before = schedules(agent)[0];
      const message = await agent.sandboxSkip();
      expect(message).toContain("accepted");
      expect(agent.getSchedules({ id: before.id })).toHaveLength(0);
      expect(agent.sandboxPrinterState()).toMatchObject({ lastStep: "accepted", nextStep: "proof" });
      expect(thread(agent).some((t) => t.includes(SIMULATED))).toBe(true);
    });
  });

  it("every sandbox method refuses outside the sandbox", async () => {
    const { stub } = await orderAgent({ sandboxAgent: false });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      await expect(agent.sandboxStartPrinter()).rejects.toThrow("sandbox only");
      await expect(agent.sandboxPrinterStep({ step: "accepted" })).rejects.toThrow("sandbox only");
      await expect(agent.sandboxSkip()).rejects.toThrow("sandbox only");
      expect(() => agent.sandboxPrinterState()).toThrow("sandbox only");
    });
  });

  it("the owner panel skips ahead and reports the printer state", async () => {
    const { token, stub } = await orderAgent();
    const call = (action: string | null) => handleApi(new Request(`https://sandbox.test/api/o/${token}/sandbox/owner${action ? `/${action}` : ""}`, action ? { method: "POST", body: "{}" } : undefined), sandbox);
    expect(await (await call("skip")).json()).toEqual({ ok: false, message: "Nothing to skip." });
    await runInDurableObject(stub, async (agent: OrderAgent) => { await agent.sandboxStartPrinter(); });
    const before = await (await call(null)).json<{ printer: { lastStep: string | null; nextStep: string | null; nextAt: string | null } }>();
    expect(before.printer).toMatchObject({ lastStep: null, nextStep: "accepted" });
    expect(Date.parse(before.printer.nextAt!)).toBeGreaterThan(Date.now());
    const res = await (await call("skip")).json<{ ok: boolean; message: string }>();
    expect(res.ok).toBe(true);
    expect(res.message).toContain("accepted");
    expect(((await (await call(null)).json()) as typeof before).printer).toMatchObject({ lastStep: "accepted", nextStep: "proof" });
  });
});

describe("watcher hook", () => {
  const TO = env.RECEIVING_ADDRESS;
  const log = (units: number, n: number): RawLog => ({
    address: USDC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, addressTopic("0x2222222222222222222222222222222222222222"), addressTopic(TO)],
    data: "0x" + (BigInt(units) * 10n ** 12n).toString(16).padStart(64, "0"),
    blockNumber: "0x" + (4010).toString(16), transactionHash: "0x" + n.toString(16).padStart(64, "0"), logIndex: "0x0",
  });
  const rpc = (logs: RawLog[], chain: number): RpcClient => ({ async chainId() { return chain; }, async blockNumber() { return 4040; }, async getLogs() { return logs; } });

  async function deposit(tag: number) {
    const { order, stub } = await orderAgent();
    const quoteId = await insertQuote(env.DB, order.id);
    await setOrderStatus(env.DB, order.id, ["draft"], "deposit_pending");
    const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token: "USDC", cents: 25750, dueBy: new Date(Date.now() + 48 * 3_600_000) }, new Date(), () => tag);
    await env.DB.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('last_block', '4000')").run();
    return { stub, req };
  }

  it("starts the printer after a completed deposit in the sandbox", async () => {
    const { stub, req } = await deposit(9101);
    await runWatcher(sandbox, { rpc: rpc([log(req.amount_units, 9101)], 5042002), telegram: silent });
    await runInDurableObject(stub, async (agent: OrderAgent) => { expect(schedules(agent).map((s) => s.payload)).toEqual([{ step: "accepted" }]); });
  });

  it("does not in production", async () => {
    const { stub, req } = await deposit(9102);
    await runWatcher(env, { rpc: rpc([log(req.amount_units, 9102)], Number(env.ARC_CHAIN_ID)), telegram: silent });
    await runInDurableObject(stub, async (agent: OrderAgent) => { expect(schedules(agent)).toHaveLength(0); });
  });
});
