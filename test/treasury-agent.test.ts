import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { createEscalation } from "../src/escalations";
import { createObligation, getObligation, listQueuedPayouts } from "../src/treasury";
import { msg, scriptedModel, toolUse } from "./helpers";

const quiet = { async send() { return 1; }, async answerCallback() {} };
const rich = { async chainId() { return 5042; }, async blockNumber() { return 1; }, async getLogs() { return []; }, async erc20Balance() { return 10_000_000_000; } };

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
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    await runInDurableObject(stub, async (agent: TreasuryAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Owner decision on obligation #${ob.id}: approved.`);
    });
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
      agent.sql`UPDATE meta SET value = '0' WHERE key = 'calls'`;
      agent.sql`DELETE FROM inbox`;
    });
  });
});
