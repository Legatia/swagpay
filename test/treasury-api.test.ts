import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { listEscalations } from "../src/escalations";
import { handleTreasuryApi } from "../src/treasury-api";
import { createObligation, getObligation, queuePayout } from "../src/treasury";
import { createSupplierPayment, getSupplierPayment, queueCashout, runnerLastSeen } from "../src/back-office";
import { newOrderRow } from "./fixtures";
import { setVendorPayout, setVendorStatus } from "../src/vendors";

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

  it("rejects a same-length wrong token and an unauthenticated result post", async () => {
    expect((await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: { authorization: "Bearer runner-secreX" } })).status).toBe(401);
    const { payout } = await queued();
    const res = await SELF.fetch(`https://swagpay.test/api/treasury/payouts/${payout.id}/result`, { method: "POST", body: JSON.stringify({ status: "sent", ref: "x" }) });
    expect(res.status).toBe(401);
    const list = await (await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: auth })).json<{ payouts: Array<{ id: number }> }>();
    expect(list.payouts.some((p) => p.id === payout.id)).toBe(true);
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
    // Not a printer's: the owner's own payout account needs no notice.
    expect((await listEscalations(env.DB)).filter((x) => JSON.parse(x.payload_json)?.payoutId === payout.id)).toEqual([]);
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
    expect(e?.summary).toContain("Check the agent wallet's transaction history before you approve a retry");
    expect(e?.summary).toContain("circle wallet limit");
  });

  it("says nothing was sent when the runner refused a payout", async () => {
    const { payout } = await queued();
    expect((await postResult(payout.id, { status: "failed", error: "runner rejected the payout: bad amount" })).status).toBe(200);
    const e = (await listEscalations(env.DB)).find((x) => JSON.parse(x.payload_json).payoutId === payout.id);
    expect(e?.summary).toContain(`The wallet runner refused payout #${payout.id}`);
    expect(e?.summary).toContain("Nothing was sent.");
    expect(e?.summary).not.toContain("may still have gone out");
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

  describe("a printer's queued payout", () => {
    const at = "2099-01-01T10:00:00.000Z";
    const VADDR = "0x" + "ab".repeat(20);
    async function queuedToPrinter() {
      const v = (await env.DB.prepare(
        "INSERT INTO vendors (name, city, country, methods, status, payout_address, payout_chain, source_ref, created_at, updated_at) VALUES ('Drukarnia Queue', 'Warsaw', 'PL', '[]', 'partner', ?, 'BASE', ?, ?, ?)",
      ).bind(VADDR, `api:${crypto.randomUUID()}`, at, at).run()).meta.last_row_id as number;
      const { order } = await newOrderRow();
      const ob = await createObligation(env.DB, {
        orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 128_750_000, destination: VADDR, chain: "BASE", dueAt: new Date(),
        sourceRef: `api:m1:${crypto.randomUUID()}`, vendorId: v,
      });
      return { v, ob, order, payout: (await queuePayout(env.DB, ob))! };
    }
    const list = async () => (await (await SELF.fetch("https://swagpay.test/api/treasury/payouts", { headers: auth })).json<{ payouts: Array<{ id: number }> }>()).payouts.map((p) => p.id);
    const payoutStatus = async (id: number) => (await env.DB.prepare("SELECT status, error FROM payouts WHERE id = ?").bind(id).first<{ status: string; error: string | null }>())!;
    const treasuryInbox = async () => runInDurableObject(await getAgentByName(env.TreasuryAgent, "treasury"), async (agent: TreasuryAgent) =>
      agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n"));

    it("is handed to the runner while its printer is a partner at that address and chain", async () => {
      const { payout } = await queuedToPrinter();
      expect(await list()).toContain(payout.id);
      expect((await payoutStatus(payout.id)).status).toBe("queued");
    });

    it("is withheld once the printer is paused: the payout and its obligation fail, and the owner decides", async () => {
      const { v, ob, payout } = await queuedToPrinter();
      await setVendorStatus(env.DB, v, "paused");
      expect(await list()).not.toContain(payout.id);
      expect(await payoutStatus(payout.id)).toEqual({ status: "failed", error: `withheld: printer #${v} is no longer a partner at this address and chain` });
      expect((await getObligation(env.DB, ob.id))?.status).toBe("failed");
      const asked = (await listEscalations(env.DB)).filter((x) => JSON.parse(x.payload_json).payoutId === payout.id);
      expect(asked).toHaveLength(1);
      expect(asked[0].kind).toBe("approval");
      expect(JSON.parse(asked[0].payload_json)).toEqual({ obligationId: ob.id, payoutId: payout.id });
      expect(asked[0].summary).toBe(
        `The wallet runner was not given payout #${payout.id} (128.750000 USDC, printer_cost obligation #${ob.id}): printer #${v} is no longer a partner at this address and chain. If the runner fetched it just before, it may still have gone out: check the wallet history. Approve to retry once the printer is registered again, or reject to settle it by hand.`,
      );
      expect(await treasuryInbox()).toContain(`Payout #${payout.id} for obligation #${ob.id} failed: withheld: printer #${v} is no longer a partner at this address and chain.`);
      // A second listing doesn't withhold it again.
      expect(await list()).not.toContain(payout.id);
      expect((await listEscalations(env.DB)).filter((x) => JSON.parse(x.payload_json).payoutId === payout.id)).toHaveLength(1);
    });

    it("is withheld when the printer registered another address or chain", async () => {
      const moved = await queuedToPrinter();
      expect(await setVendorPayout(env.DB, moved.v, "0x" + "cd".repeat(20), "BASE")).toBe("ok");
      const rechained = await queuedToPrinter();
      expect(await setVendorPayout(env.DB, rechained.v, VADDR, "ARC")).toBe("ok");
      const ids = await list();
      expect(ids).not.toContain(moved.payout.id);
      expect(ids).not.toContain(rechained.payout.id);
      expect((await payoutStatus(moved.payout.id)).status).toBe("failed");
      expect((await payoutStatus(rechained.payout.id)).status).toBe("failed");
    });

    it("tells the owner once when a printer's payout is sent, naming the printer", async () => {
      const { v, ob, order, payout } = await queuedToPrinter();
      expect((await postResult(payout.id, { status: "sent", ref: "circle-tx-5" })).status).toBe(200);
      expect((await postResult(payout.id, { status: "sent", ref: "circle-tx-5" })).status).toBe(409);
      const told = (await listEscalations(env.DB)).filter((x) => JSON.parse(x.payload_json)?.payoutId === payout.id);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ kind: "payment", order_id: order.id, status: "open" });
      expect(told[0].summary).toBe(`Order ${order.id}: printer #${v} Drukarnia Queue milestone #${ob.id} paid, 128.750000 USDC (ref circle-tx-5).`);
      // Acknowledging it moves no money.
      await SELF.fetch(new Request("https://swagpay.test/api/telegram", {
        method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: JSON.stringify({ message: { chat: { id: 42 }, text: `/approve ${told[0].id}` } }),
      }));
      expect((await listEscalations(env.DB)).find((x) => x.id === told[0].id)?.status).toBe("approved");
      expect((await getObligation(env.DB, ob.id))?.status).toBe("paid");
      // The treasury hears the result without the printer's name.
      expect(await treasuryInbox()).not.toContain("Drukarnia");
    });

    it("compares the address without regard to case", async () => {
      const { v, payout } = await queuedToPrinter();
      await env.DB.prepare("UPDATE vendors SET payout_address = ? WHERE id = ?").bind("0x" + "AB".repeat(20), v).run();
      expect(await list()).toContain(payout.id);
    });
  });
});

describe("treasury runner API: cash-outs", () => {
  const postC = (id: number, b: unknown) => SELF.fetch(`https://swagpay.test/api/treasury/cashouts/${id}/result`, { method: "POST", headers: auth, body: JSON.stringify(b) });
  const listC = async () => (await (await SELF.fetch("https://swagpay.test/api/treasury/cashouts", { headers: auth })).json<{ cashouts: Array<Record<string, unknown>> }>()).cashouts;
  async function queuedC() {
    const { order } = await newOrderRow();
    const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
    return { order, sp, c: (await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 23_721 }))! };
  }

  it("lists live cash-outs, remembers the runner's poll, and records sold then withdrawn once", async () => {
    const { order, sp, c } = await queuedC();
    const listed = (await listC()).find((x) => x.id === c.id);
    expect(listed).toMatchObject({ fiat: "EUR", amount: "237.21", clientOrderId: c.client_order_id, status: "queued" });
    expect(await runnerLastSeen(env.DB)).not.toBeNull();
    expect((await postC(c.id, { stage: "sold", orderRef: "OABC", soldUnits: "240.500000" })).status).toBe(200);
    expect((await postC(c.id, { stage: "sold", orderRef: "OABC", soldUnits: "240.500000" })).status).toBe(409);
    expect((await postC(c.id, { stage: "withdrawn", withdrawalRef: "WREF", feeCents: 100 })).status).toBe(200);
    expect((await getSupplierPayment(env.DB, sp.id))?.status).toBe("ready");
    const notice = (await listEscalations(env.DB)).find((e) => e.summary.startsWith(`237.21 EUR withdrawn to your EUR account for order ${order.id}`))!;
    expect(notice).toMatchObject({ kind: "payment", order_id: null });
    expect(notice.summary).toContain(`https://app.swagpay.me/admin/orders/${order.id}`);
    expect((await postC(c.id, { stage: "withdrawn", withdrawalRef: "WREF", feeCents: 100 })).status).toBe(409);
    expect((await listC()).some((x) => x.id === c.id)).toBe(false);
  });

  it("tells the owner when a cash-out fails, or its withdrawal fails three times", async () => {
    const a = await queuedC();
    expect((await postC(a.c.id, { status: "failed", error: "USDC has not arrived at Kraken" })).status).toBe(200);
    expect((await listEscalations(env.DB)).some((e) => e.kind === "system" && e.summary.includes(`Cash-out #${a.c.id} for order ${a.order.id} failed: USDC has not arrived at Kraken`))).toBe(true);
    const b = await queuedC();
    await postC(b.c.id, { stage: "sold", orderRef: "O", soldUnits: "1.000000" });
    for (const e of ["e1", "e2"]) expect((await postC(b.c.id, { stage: "withdraw_error", error: e })).status).toBe(200);
    expect((await listEscalations(env.DB)).some((e) => e.summary.includes(`cash-out #${b.c.id}`))).toBe(false);
    expect((await postC(b.c.id, { stage: "withdraw_error", error: "e3" })).status).toBe(200);
    expect((await listEscalations(env.DB)).some((e) => e.summary.startsWith(`The withdrawal for cash-out #${b.c.id} failed 3 times`))).toBe(true);
  });

  it("rejects bad bodies", async () => {
    const { c } = await queuedC();
    expect((await postC(c.id, { stage: "sold", orderRef: "O", soldUnits: "-1" })).status).toBe(400);
    expect((await postC(c.id, { stage: "nope" })).status).toBe(400);
    expect((await postC(c.id, { stage: "withdrawn", withdrawalRef: "W", feeCents: 1.5 })).status).toBe(400);
  });
});
