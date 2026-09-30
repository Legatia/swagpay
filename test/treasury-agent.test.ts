import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { TREASURY_PROMPT } from "../src/agent/treasury-prompt";
import { createEscalation, listEscalations } from "../src/escalations";
import { handleTelegram } from "../src/telegram-webhook";
import { createObligation, getObligation, listQueuedPayouts, queuePayout, recordPayoutResult, setObligationStatus } from "../src/treasury";
import { setVendorStatus } from "../src/vendors";
import { newOrderRow } from "./fixtures";
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

  it("an approval without a payoutId can't move an obligation that already has a payout", async () => {
    const ob = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 5_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `n:${crypto.randomUUID()}` });
    const stale = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "over the limit", payload: { obligationId: ob.id } });
    const p = (await queuePayout(env.DB, ob))!;
    await recordPayoutResult(env.DB, p.id, { status: "denied", error: "exceeds daily limit" });
    expect((await getObligation(env.DB, ob.id))?.status).toBe("escalated");
    await SELF.fetch(fromOwner(`/approve ${stale.id}`));
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "escalated", approved_by: null });
    const denial = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "denied", payload: { obligationId: ob.id, payoutId: p.id } });
    await SELF.fetch(fromOwner(`/approve ${denial.id}`));
    expect(await getObligation(env.DB, ob.id)).toMatchObject({ status: "approved", approved_by: "owner" });
  });

  async function snapshotLines(): Promise<string[]> {
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    return runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      const model = scriptedModel([msg([], "end_turn")]);
      agent.modelOverride = model;
      await agent.notify("Daily review.");
      await agent.processTurn();
      const blocks = model.requests[0].messages.at(-1)!.content as Array<{ text: string }>;
      return blocks.at(-1)!.text.replace(/^<event>|<\/event>$/g, "").split("\n");
    });
  }

  it("the snapshot lists closed orders not yet swept, newest first, and leaves settled obligations out", async () => {
    const orders = [];
    for (let i = 0; i < 5; i++) orders.push((await newOrderRow()).order);
    const [swept, older, newer, eurc, noCost] = orders;
    await env.DB.prepare("UPDATE orders SET status = 'closed' WHERE id IN (?, ?, ?, ?, ?)").bind(...orders.map((o) => o.id)).run();
    const cost = (orderId: number, token: "USDC" | "EURC") => createObligation(env.DB, { orderId, kind: "printer_cost", token, amountUnits: 1_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `c:${crypto.randomUUID()}` });
    for (const o of [swept, older, newer]) await cost(o.id, "USDC");
    await cost(eurc.id, "EURC");
    await createObligation(env.DB, { orderId: swept.id, kind: "reserve", token: "USDC", amountUnits: 1_000_000, destination: "0x4444444444444444444444444444444444444444", chain: "ARC", dueAt: new Date(), sourceRef: `reserve:order:${swept.id}` });
    const settled = await createObligation(env.DB, { orderId: null, kind: "refund", token: "EURC", amountUnits: 1_000_000, destination: "0x2222222222222222222222222222222222222222", chain: "ARC", dueAt: new Date(), sourceRef: `x:${crypto.randomUUID()}`, status: "escalated" });
    await setObligationStatus(env.DB, settled.id, ["escalated"], "settled");
    const lines = await snapshotLines();
    const unswept = lines.find((l) => l.startsWith("Closed orders not yet swept: "))!;
    const ids = unswept.slice("Closed orders not yet swept: ".length).split(", ");
    expect(ids.slice(0, 2)).toEqual([`#${newer.id}`, `#${older.id}`]);
    // Only orders a sweep can succeed on: an EURC order or one with no recorded printer cost would be blocked every time.
    for (const out of [swept, eurc, noCost]) expect(ids).not.toContain(`#${out.id}`);
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(lines.some((l) => l.startsWith(`- #${settled.id} `))).toBe(false);
  });

  it("the snapshot lists payouts queued for over two hours", async () => {
    const fresh = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 1_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `q:${crypto.randomUUID()}` });
    const stuck = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 1_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `q:${crypto.randomUUID()}` });
    const recent = (await queuePayout(env.DB, fresh))!;
    const old = (await queuePayout(env.DB, stuck, new Date(Date.now() - 5 * 3_600_000 - 60_000)))!;
    const line = (await snapshotLines()).find((l) => l.startsWith("Payouts queued over 2 hours: "));
    expect(line).toContain(`#${old.id} (5 h)`);
    expect(line).not.toContain(`#${recent.id} `);
    expect(TREASURY_PROMPT).toContain("If payouts have been queued for hours, the wallet runner may be down: escalate.");
  });

  it("the snapshot names a printer's milestones by printer number, and a waiting one as due after printing", async () => {
    const { order } = await newOrderRow();
    const at = "2099-01-01T10:00:00.000Z";
    const address = "0x" + "ab".repeat(20);
    const v = (await env.DB.prepare(
      "INSERT INTO vendors (name, city, country, methods, status, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES ('Drukarnia Secret', 'Warsaw', 'PL', '[]', 'partner', ?, 'BASE', ?, ?, ?)",
    ).bind(address, `ta:${crypto.randomUUID()}`, at, at).run()).meta.last_row_id as number;
    const base = { orderId: order.id, kind: "printer_cost" as const, token: "USDC" as const, amountUnits: 128_750_000, destination: address, chain: "BASE", dueAt: new Date(), vendorId: v };
    const m1 = await createObligation(env.DB, { ...base, sourceRef: `m1:${crypto.randomUUID()}` });
    const m2 = await createObligation(env.DB, { ...base, sourceRef: `m2:${crypto.randomUUID()}`, status: "waiting" });
    const lines = await snapshotLines();
    expect(lines).toContain(`- #${m1.id} printer_cost order ${order.id}: 128.750000 USDC to BASE printer #${v}, open`);
    expect(lines).toContain(`- #${m2.id} printer_cost order ${order.id}: 128.750000 USDC to BASE printer #${v}, waiting (due after printing)`);
    expect(lines.join("\n")).not.toContain("Drukarnia Secret");
    expect(TREASURY_PROMPT).toContain("Printer costs for a partner printer go straight to the printer in two milestones: pay the first when the deposit completes and the second once it is due after printing. Pay only to the printer's registered address; if a printer is paused or its address changed, escalate.");
  });

  it("a paused printer's milestone goes to the owner once; approving re-checks it, rejecting settles it", async () => {
    const { order } = await newOrderRow();
    const at = "2099-01-01T10:00:00.000Z";
    const address = "0x" + "cd".repeat(20);
    const v = (await env.DB.prepare(
      "INSERT INTO vendors (name, city, country, methods, status, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES ('Drukarnia Hidden', 'Warsaw', 'PL', '[]', 'partner', ?, 'BASE', ?, ?, ?)",
    ).bind(address, `ta:${crypto.randomUUID()}`, at, at).run()).meta.last_row_id as number;
    const m1 = await createObligation(env.DB, {
      orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 128_750_000, destination: address, chain: "BASE", dueAt: new Date(),
      sourceRef: `m1:${crypto.randomUUID()}`, vendorId: v,
    });
    await setVendorStatus(env.DB, v, "paused");
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    const payTwice = async () => runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      agent.modelOverride = scriptedModel([
        msg([toolUse("pay_obligation", { obligationId: m1.id, reason: "first milestone is due" })], "tool_use"),
        msg([toolUse("pay_obligation", { obligationId: m1.id, reason: "try once more" })], "tool_use"),
        msg([], "end_turn"),
      ]);
      await agent.notify(`Milestone obligation #${m1.id} is due.`);
      await agent.processTurn();
    });
    const asked = async () => (await listEscalations(env.DB))
      .filter((x) => x.summary.startsWith(`Treasury: printer_cost obligation #${m1.id} `))
      .sort((a, b) => a.id - b.id);
    const queuedFor = async () => (await listQueuedPayouts(env.DB, 200)).filter((p) => p.obligation_id === m1.id);

    await payTwice();
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "escalated" });
    const first = await asked();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "approval", order_id: null });
    expect(JSON.parse(first[0].payload_json)).toEqual({ obligationId: m1.id });
    expect(first[0].summary).toContain(`can't be paid: printer #${v} is not a partner.`);
    expect(first[0].summary).not.toContain("Drukarnia");
    expect(await queuedFor()).toEqual([]);

    // Approve: the treasury re-checks, and a still-paused printer goes back to the owner.
    await SELF.fetch(fromOwner(`/approve ${first[0].id}`));
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "approved", approved_by: "owner" });
    await payTwice();
    expect((await getObligation(env.DB, m1.id))?.status).toBe("escalated");
    const again = await asked();
    expect(again).toHaveLength(2);
    expect(await queuedFor()).toEqual([]);

    // Reject: the owner pays it by hand or it isn't owed.
    await SELF.fetch(fromOwner(`/reject ${again[1].id}`));
    expect((await getObligation(env.DB, m1.id))?.status).toBe("settled");
    expect(await inboxOf()).not.toContain("Drukarnia");
  });

  it("a printer escalation after a withheld payout can still be decided: approve re-checks, reject settles", async () => {
    const { order } = await newOrderRow();
    const at = "2099-01-01T10:00:00.000Z";
    const address = "0x" + "ef".repeat(20);
    const v = (await env.DB.prepare(
      "INSERT INTO vendors (name, city, country, methods, status, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES ('Drukarnia Withheld', 'Warsaw', 'PL', '[]', 'partner', ?, 'BASE', ?, ?, ?)",
    ).bind(address, `ta:${crypto.randomUUID()}`, at, at).run()).meta.last_row_id as number;
    const m1 = await createObligation(env.DB, {
      orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 128_750_000, destination: address, chain: "BASE", dueAt: new Date(),
      sourceRef: `m1:${crypto.randomUUID()}`, vendorId: v,
    });
    const payout = (await queuePayout(env.DB, m1))!;
    await setVendorStatus(env.DB, v, "paused");
    // The runner's fetch withholds it; the owner approves a retry.
    await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: { authorization: "Bearer runner-secret" } });
    expect((await getObligation(env.DB, m1.id))?.status).toBe("failed");
    const withheld = (await listEscalations(env.DB)).find((x) => JSON.parse(x.payload_json).payoutId === payout.id && x.summary.includes("The wallet runner was not given payout"))!;
    await SELF.fetch(fromOwner(`/approve ${withheld.id}`));
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "approved", approved_by: "owner" });

    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    const pay = async () => runInDurableObject(stub, async (agent: TreasuryAgent) => {
      agent.telegramOverride = quiet;
      agent.rpcOverride = rich;
      agent.modelOverride = scriptedModel([msg([toolUse("pay_obligation", { obligationId: m1.id, reason: "owner approved the retry" })], "tool_use"), msg([], "end_turn")]);
      await agent.notify(`Obligation #${m1.id} was approved.`);
      await agent.processTurn();
    });
    const asked = async () => (await listEscalations(env.DB))
      .filter((x) => x.summary.startsWith(`Treasury: printer_cost obligation #${m1.id} `))
      .sort((a, b) => a.id - b.id);

    // Still paused: the printer escalation carries the latest payout, so a decision can move it.
    await pay();
    expect((await getObligation(env.DB, m1.id))?.status).toBe("escalated");
    const first = await asked();
    expect(first).toHaveLength(1);
    expect(JSON.parse(first[0].payload_json)).toEqual({ obligationId: m1.id, payoutId: payout.id });
    expect(first[0].summary).toContain(`for 128.750000 USDC can't be paid: printer #${v} is not a partner.`);
    await SELF.fetch(fromOwner(`/approve ${first[0].id}`));
    expect(await getObligation(env.DB, m1.id)).toMatchObject({ status: "approved", approved_by: "owner" });

    await pay();
    expect((await getObligation(env.DB, m1.id))?.status).toBe("escalated");
    const second = await asked();
    expect(second).toHaveLength(2);
    await SELF.fetch(fromOwner(`/reject ${second[1].id}`));
    expect((await getObligation(env.DB, m1.id))?.status).toBe("settled");
    // Only the withheld payout ever existed; nothing went out.
    const payouts = (await env.DB.prepare("SELECT status FROM payouts WHERE obligation_id = ?").bind(m1.id).all<{ status: string }>()).results;
    expect(payouts).toEqual([{ status: "failed" }]);
  });
});
