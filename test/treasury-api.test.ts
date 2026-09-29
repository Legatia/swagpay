import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { listEscalations } from "../src/escalations";
import { handleTreasuryApi } from "../src/treasury-api";
import { createObligation, getObligation, queuePayout } from "../src/treasury";

const auth = { authorization: "Bearer runner-secret" };
async function queued(amountUnits = 12_345_678) {
  const ob = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC", dueAt: new Date(), sourceRef: `api:${crypto.randomUUID()}` });
  return { ob, payout: (await queuePayout(env.DB, ob))! };
}
const postResult = (id: number, b: unknown) => SELF.fetch(`https://swagpay.test/api/treasury/payouts/${id}/result`, { method: "POST", headers: auth, body: JSON.stringify(b) });

describe("treasury runner API", () => {
  it("needs the bearer token and is off without one", async () => {
    expect((await SELF.fetch("https://swagpay.test/api/treasury/payouts")).status).toBe(401);
    expect((await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const off = await handleTreasuryApi(new Request("https://swagpay.test/api/treasury/payouts", { headers: auth }), { ...env, TREASURY_RUNNER_TOKEN: "" } as Env);
    expect(off.status).toBe(404);
  });

  it("lists queued payouts with decimal amounts", async () => {
    const { payout } = await queued();
    const body = await (await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: auth })).json<{ payouts: Array<Record<string, unknown>> }>();
    expect(body.payouts.find((p) => p.id === payout.id)).toMatchObject({ method: "bridge", chain: "MATIC", token: "USDC", amount: "12.345678", destination: "0x3333333333333333333333333333333333333333", idempotencyKey: payout.idempotency_key });
  });

  it("records sent, tells the treasury, and ignores a duplicate", async () => {
    const { ob, payout } = await queued();
    expect((await postResult(payout.id, { status: "sent", ref: "circle-tx-9" })).status).toBe(200);
    expect((await getObligation(env.DB, ob.id))?.status).toBe("paid");
    expect((await postResult(payout.id, { status: "failed", error: "late" })).status).toBe(409);
    const stub = await getAgentByName(env.TreasuryAgent, "treasury");
    await runInDurableObject(stub, async (agent: TreasuryAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Payout #${payout.id} for obligation #${ob.id} sent (ref circle-tx-9).`);
    });
  });

  it("escalates a payout Circle's limit denied", async () => {
    const { ob, payout } = await queued();
    const res = await postResult(payout.id, { status: "denied", error: "exceeds daily limit" });
    expect(res.status).toBe(200);
    expect((await getObligation(env.DB, ob.id))?.status).toBe("escalated");
    const e = (await listEscalations(env.DB)).find((x) => x.summary.includes(`payout #${payout.id}`));
    expect(e?.kind).toBe("approval");
    const payload = JSON.parse(e!.payload_json);
    expect(payload.obligationId).toBe(ob.id);
    expect(payload.payoutId).toBe(payout.id);
  });

  it("escalates a failed payout too, since the transfer may have gone out", async () => {
    const { ob, payout } = await queued();
    const res = await postResult(payout.id, { status: "failed", error: "RPC timeout" });
    expect(res.status).toBe(200);
    expect((await getObligation(env.DB, ob.id))?.status).toBe("failed");
    const e = (await listEscalations(env.DB)).find((x) => JSON.parse(x.payload_json).payoutId === payout.id);
    expect(e?.kind).toBe("approval");
    expect(e?.summary).toContain(`Payout #${payout.id}`);
    expect(e?.summary).toContain("check the agent wallet's transaction history");
    expect(e?.summary).toContain("RPC timeout");
    const payload = JSON.parse(e!.payload_json);
    expect(payload.obligationId).toBe(ob.id);
    expect(payload.payoutId).toBe(payout.id);
  });

  it("rejects malformed results", async () => {
    const { payout } = await queued();
    expect((await postResult(payout.id, { status: "maybe" })).status).toBe(400);
  });
});
