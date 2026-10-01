import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSupplierPayment, getCashout, getSupplierPayment, queueCashout } from "../../src/back-office";
import type { ChainClient } from "../../src/sandbox/chain";
import { runSandboxRunner } from "../../src/sandbox/runner";
import { createObligation, queuePayout, type PayoutRow } from "../../src/treasury";

const sandbox = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002" } as unknown as Env;
const DEST = "0x3333333333333333333333333333333333333333";

function fakeChain() {
  const sent: Array<{ to: string; units: number }> = [];
  const chain: ChainClient = { address: () => "0xfake", transferUsdc: async (to, units) => { sent.push({ to, units }); return `0xhash${sent.length}`; } };
  return { chain, sent };
}

async function queued(chain: "ARC" | "MATIC" = "ARC", amountUnits = 12_500_000): Promise<PayoutRow> {
  const ob = await createObligation(env.DB, { orderId: null, kind: "printer_cost", token: "USDC", amountUnits, destination: DEST, chain, dueAt: new Date(), sourceRef: `t:${crypto.randomUUID()}` });
  return (await queuePayout(env.DB, ob))!;
}
const payoutRow = (id: number) => env.DB.prepare("SELECT * FROM payouts WHERE id = ?").bind(id).first<PayoutRow>();

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM sandbox_runner_sends"), env.DB.prepare("UPDATE payouts SET status = 'failed' WHERE status = 'queued'")]);
});

describe("sandbox runner", () => {
  it("throws when a treasury GET is refused, after still running the other pass", async () => {
    const bad = { ...sandbox, TREASURY_RUNNER_TOKEN: "" } as unknown as Env;
    await expect(runSandboxRunner(bad, { chain: fakeChain().chain })).rejects.toThrow("treasury api /api/treasury/payouts: HTTP 404");
  });

  it("sends a queued ARC payout once and reports it sent", async () => {
    const p = await queued();
    const { chain, sent } = fakeChain();
    await runSandboxRunner(sandbox, { chain });
    expect(sent).toEqual([{ to: DEST, units: 12_500_000 }]);
    expect(await payoutRow(p.id)).toMatchObject({ status: "sent", result_ref: "0xhash1" });
    await runSandboxRunner(sandbox, { chain });
    expect(sent).toHaveLength(1);
  });

  it("reports a broadcast-then-crash send with its recorded hash and does not send again", async () => {
    const p = await queued();
    await env.DB.prepare("INSERT INTO sandbox_runner_sends (idempotency_key, payout_id, tx_hash, created_at) VALUES (?, ?, '0xcrashed', ?)").bind(p.idempotency_key, p.id, new Date().toISOString()).run();
    const { chain, sent } = fakeChain();
    await runSandboxRunner(sandbox, { chain });
    expect(sent).toEqual([]);
    expect(await payoutRow(p.id)).toMatchObject({ status: "sent", result_ref: "0xcrashed" });
  });

  it("fails a claimed key without a hash instead of sending", async () => {
    const p = await queued();
    await env.DB.prepare("INSERT INTO sandbox_runner_sends (idempotency_key, payout_id, created_at) VALUES (?, ?, ?)").bind(p.idempotency_key, p.id, new Date().toISOString()).run();
    const { chain, sent } = fakeChain();
    await runSandboxRunner(sandbox, { chain });
    expect(sent).toEqual([]);
    expect(await payoutRow(p.id)).toMatchObject({ status: "failed", error: "sandbox runner: send state unknown for this key; check the explorer" });
  });

  it("refuses a bridge payout", async () => {
    const p = await queued("MATIC");
    const { chain, sent } = fakeChain();
    await runSandboxRunner(sandbox, { chain });
    expect(sent).toEqual([]);
    expect(await payoutRow(p.id)).toMatchObject({ status: "failed", error: "sandbox: only ARC transfers" });
  });

  it("reports a failed transfer, and a missing wallet key, without claiming the key", async () => {
    const p = await queued();
    const boom: ChainClient = { address: () => "0xfake", transferUsdc: async () => { throw new Error("rpc down"); } };
    await runSandboxRunner(sandbox, { chain: boom });
    expect(await payoutRow(p.id)).toMatchObject({ status: "failed", error: "sandbox transfer failed: rpc down" });
    const q = await queued();
    await runSandboxRunner({ ...sandbox, SANDBOX_WALLET_KEY: "" } as unknown as Env);
    expect(await payoutRow(q.id)).toMatchObject({ status: "failed", error: "SANDBOX_WALLET_KEY is not set" });
    expect(await env.DB.prepare("SELECT 1 AS x FROM sandbox_runner_sends WHERE idempotency_key = ?").bind(q.idempotency_key).first()).toBeNull();
  });

  it("cashes out through the mock bank and makes the supplier payment ready", async () => {
    const { newOrderRow } = await import("../fixtures");
    const { order } = await newOrderRow();
    const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "PLN", amountCents: 100_000 });
    const c = (await queueCashout(env.DB, sp.id, { fiat: "EUR", fiatCents: 20_000 }))!;
    await runSandboxRunner(sandbox, { chain: fakeChain().chain });
    expect(await getCashout(env.DB, c.id)).toMatchObject({ status: "withdrawn", withdrawal_ref: `SIM-WD-${c.id}` });
    expect((await getSupplierPayment(env.DB, sp.id))!.status).toBe("ready");
  });

  it("does nothing outside the sandbox or off testnet", async () => {
    const p = await queued();
    const { chain, sent } = fakeChain();
    await runSandboxRunner(env, { chain });
    await runSandboxRunner({ ...sandbox, ARC_CHAIN_ID: "5042" } as unknown as Env, { chain });
    expect(sent).toEqual([]);
    expect((await payoutRow(p.id))!.status).toBe("queued");
  });
});
