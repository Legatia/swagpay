import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { createEscalation, listEscalations } from "../src/escalations";
import { handleTelegram } from "../src/telegram-webhook";
import { createObligation, getObligation, listQueuedPayouts, queuePayout, recordPayoutResult, setObligationStatus } from "../src/treasury";
import { msg, scriptedModel, toolUse } from "./helpers";

const quiet = { async send() { return 1; }, async answerCallback() {} };
const rich = { async chainId() { return 5042; }, async blockNumber() { return 1; }, async getLogs() { return []; }, async erc20Balance() { return 10_000_000_000; } };
const fromOwner = (text: string) => new Request("https://swagpay.test/api/telegram", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
  body: JSON.stringify({ message: { chat: { id: 42 }, text } }),
});
const inboxOf = async () => runInDurableObject(await getAgentByName(env.TreasuryAgent, "treasury"), async (agent: TreasuryAgent) =>
  agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n"));

describe("TreasuryAgent", () => {
  it("pays an open printer cost on a deposit event and logs the decision", async () => {
    const ob = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 257_500_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `t:${crypto.randomUUID()}` });
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    await runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      const model = scriptedModel([msg([toolUse("pay_obligation", { obligationId: ob.id, reason: "deposit paid; printer cost to the payout account" })], "tool_use"), msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.notify(`Order deposit completed. Obligation #${ob.id}: printer cost 257.500000 USDC to the payout account.`);
      await agent.processTurn();
      const first = JSON.stringify(model.requests[0].messages.at(-1));
      expect(first).toContain("Treasury snapshot: wallet 10000.000000 USDC");
      expect(first).toContain(`#${ob.id} printer_cost`);
    });
    expect((await getObligation(env.DB, ob.id))?.status).toBe("queued");
    expect((await listQueuedPayouts(env.DB, 200)).some((p) => p.obligation_id === ob.id)).toBe(true);
    const log = (await env.DB.prepare("SELECT tool, verdict FROM treasury_decisions ORDER BY id DESC LIMIT 1").first<{ tool: string; verdict: string }>())!;
    expect(log).toEqual({ tool: "pay_obligation", verdict: "allow" });
  });

  it("an owner approval of an obligation escalation approves it and wakes the treasury", async () => {
    const ob = await createObligation(env.DB, { orderId: null, kind: "refund", token: "USDC", amountUnits: 5_000_000, destination: "0x2222222222222222222222222222222222222222", chain: "ARC", dueAt: new Date(), sourceRef: `r:${crypto.randomUUID()}`, status: "escalated" });
    const e = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Refund?", payload: { obligationId: ob.id } });
    const res = await SELF.fetch(new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text: `/approve ${e.id}` } }),
    }));
    expect(res.status).toBe(200);
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "approved", approved_by: "owner" });
    expect(await inboxOf()).toContain(`Owner decision on escalation #${e.id} (summary: "obligation #${ob.id} (now approved): Refund?"): approved.`);
  });

  it("an owner decision on a treasury escalation reaches the treasury and re-arms the question", async () => {
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    const summary = `The wallet needs a top-up ${crypto.randomUUID()}`;
    const escalateTurn = async () => runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      agent.modelOverride = scriptedModel([msg([toolUse("escalate", { summary, reason: "the wallet runs low" })], "tool_use"), msg([], "end_turn")]);
      await agent.notify("Daily review.");
      await agent.processTurn();
    });
    const asked = async () => (await listEscalations(env.DB, { limit: 500 })).filter((x) => x.summary === `Treasury: ${summary}`);
    await escalateTurn();
    const [first] = await asked();
    expect(first).toMatchObject({ kind: "agent", order_id: null });
    expect(JSON.parse(first.payload_json)).toEqual({ treasury: true });
    expect((await handleTelegram(fromOwner(`/approve ${first.id} topped up`), env, { telegram: quiet })).status).toBe(200);
    expect(await inboxOf()).toContain(`Owner decision on escalation #${first.id} (summary: ${JSON.stringify(`Treasury: ${summary}`)}): approved. Note from the owner: "topped up".`);
    await escalateTurn();
    const both = await asked();
    expect(both).toHaveLength(2);
    expect(both.map((x) => x.id)).toContain(first.id);
  });

  it("stops at the daily model call budget", async () => {
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    await runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      agent.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
      agent.sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('calls_day', ${new Date().toISOString().slice(0, 10)}), ('calls', '60')`;
      let called = false;
      agent.modelOverride = { async create() { called = true; throw new Error("should not be called"); } };
      await agent.notify("Daily review.");
      expect(await agent.processTurn()).toBeNull();
      expect(called).toBe(false);
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text)).toContain("Daily review.");
      const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM treasury_decisions WHERE reason = 'daily model call budget spent'").first<{ n: number }>();
      expect(logged!.n).toBeGreaterThan(0);
      agent.sql`UPDATE meta SET value = '0' WHERE key = 'calls'`;
      agent.sql`DELETE FROM inbox`;
    });
  });

  async function decide(cmd: string, kind: "approval" | "payment", payload: Record<string, unknown>, status: "open" | "escalated" | "failed", token: "USDC" | "EURC" = "USDC") {
    const ob = await createObligation(env.DB, { orderId: null, kind: "refund", token, amountUnits: 5_000_000, destination: "0x2222222222222222222222222222222222222222", chain: "ARC", dueAt: new Date(), sourceRef: `d:${crypto.randomUUID()}`, ...(status === "failed" ? {} : { status }) });
    if (status === "failed") await setObligationStatus(env.DB, ob.id, ["open"], "failed");
    const e = await createEscalation(env.DB, { orderId: null, kind, summary: "x", payload: { obligationId: ob.id, ...payload } });
    const res = await SELF.fetch(new Request("https://swagpay.test/api/telegram", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text: `${cmd} ${e.id}` } }),
    }));
    expect(res.status).toBe(200);
    return getObligation(env.DB, ob.id);
  }

  it("acknowledging a payment notice leaves an open obligation open", async () => {
    expect(await decide("/approve", "payment", {}, "open")).toMatchObject({ status: "open", approved_by: null });
  });

  it("rejecting an approval settles an escalated obligation: the owner handles it", async () => {
    expect(await decide("/reject", "approval", {}, "escalated")).toMatchObject({ status: "settled", approved_by: null });
  });

  it("approving a EURC obligation settles it: the treasury only pays USDC", async () => {
    expect(await decide("/approve", "approval", {}, "escalated", "EURC")).toMatchObject({ status: "settled", approved_by: "owner" });
  });

  it("an approval reopens a failed obligation only with a payoutId", async () => {
    expect((await decide("/approve", "approval", {}, "failed"))?.status).toBe("failed");
    expect(await decide("/approve", "approval", { payoutId: 1 }, "failed")).toMatchObject({ status: "approved", approved_by: "owner" });
  });

  it("a stale payout's approval leaves a newer failed payout alone", async () => {
    const ob = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 5_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `s:${crypto.randomUUID()}` });
    const p1 = (await queuePayout(env.DB, ob))!;
    await recordPayoutResult(env.DB, p1.id, { status: "failed", error: "RPC timeout" });
    const p2 = (await queuePayout(env.DB, (await getObligation(env.DB, ob.id))!))!;
    await recordPayoutResult(env.DB, p2.id, { status: "failed", error: "RPC timeout" });
    const stale = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "old", payload: { obligationId: ob.id, payoutId: p1.id } });
    await SELF.fetch(fromOwner(`/approve ${stale.id}`));
    expect((await getObligation(env.DB, ob.id))?.status).toBe("failed");
    const latest = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "new", payload: { obligationId: ob.id, payoutId: p2.id } });
    await SELF.fetch(fromOwner(`/approve ${latest.id}`));
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "approved", approved_by: "owner" });
  });
});
