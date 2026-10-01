import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSupplierPayment } from "../../src/back-office";
import { createObligation, queuePayout, recordPayoutResult } from "../../src/treasury";
import { bankPass, handleSandboxBank, type BankCashout } from "../../src/sandbox/bank";
import { insertQuote, newOrderRow } from "../fixtures";

const now = new Date("2099-10-01T10:00:00Z");
const cashout = (o: Partial<BankCashout> = {}): BankCashout => ({ id: 9, fiat: "EUR", amount: "100.00", clientOrderId: "co-9", status: "queued", createdAt: now.toISOString(), ...o });

async function rates(eur: number, usd: number) {
  for (const [code, v] of [["EUR", eur], ["USD", usd]] as const) {
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES (?, ?, '2099-10-01', ?)").bind(code, v, now.toISOString()).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sandbox_bank_ledger").run();
  await env.DB.prepare("DELETE FROM fx_rates").run();
});

describe("bankPass", () => {
  it("sells at the NBP cross rate plus a 0.5% spread, then withdraws to the owner's masked account", async () => {
    await rates(4.27, 3.95); // 1 EUR = 1.0810127 USD; 100 EUR x 1.0810127 x 1.005 = 108.641773 USDC (rounded up)
    const out = await bankPass(env, cashout(), now);
    expect(out[0]).toEqual({ stage: "sold", orderRef: "SIM-SELL-9", soldUnits: "108.641773" });
    expect(out[1]).toEqual({ stage: "withdrawn", withdrawalRef: "SIM-WD-9", feeCents: 0 });
    const w = await env.DB.prepare("SELECT account_masked, fiat_cents FROM sandbox_bank_ledger WHERE step = 'withdrawn'").first<{ account_masked: string; fiat_cents: number }>();
    expect(w).toEqual({ account_masked: "owner's EUR account ••••4242", fiat_cents: 10000 });
  });

  it("second pass returns the recorded steps without selling again", async () => {
    await rates(4.27, 3.95);
    const a = await bankPass(env, cashout(), now);
    await rates(5, 3); // rates move; the recorded sale must not
    const b = await bankPass(env, cashout(), now);
    expect(b).toEqual(a);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sandbox_bank_ledger").first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it("only withdraws for a cash-out already sold", async () => {
    await rates(4.27, 3.95);
    const out = await bankPass(env, cashout({ status: "sold" }), now);
    expect(out).toEqual([{ stage: "withdrawn", withdrawalRef: "SIM-WD-9", feeCents: 0 }]);
  });

  it("uses a labelled fallback rate when NBP rates are missing", async () => {
    const out = await bankPass(env, cashout({ fiat: "GBP", clientOrderId: "co-g" }), now);
    expect(out[0]).toMatchObject({ stage: "sold", soldUnits: "127.635000" }); // 1.27 × 1.005
    const res = await handleSandboxBank(new Request("https://x/api/sandbox/bank"), { ...env, SANDBOX: "1" } as unknown as Env);
    const body = await res.json<{ cashouts: { steps: { step: string; rateSource: string | null }[] }[] }>();
    expect(body.cashouts[0].steps.map((s) => [s.step, s.rateSource])).toEqual([["sold", "fallback"], ["withdrawn", null]]);
  });
});

const HASH = `0x${"ab".repeat(32)}`;

// The cash-out's order, its supplier payment and cash-out row, and (optionally) the treasury's payout to the mock bank.
async function seededCashout(payout: { status: "sent" | "failed"; ref: string } | null) {
  const { order } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id);
  const ob = await createObligation(env.DB, { orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 4_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "ARC", dueAt: new Date(), sourceRef: `printer_cost:quote:${quoteId}` });
  if (payout) await recordPayoutResult(env.DB, (await queuePayout(env.DB, ob))!.id, payout);
  const sp = await createSupplierPayment(env.DB, { orderId: order.id, vendorId: null, currency: "EUR", amountCents: 10_000 });
  const res = await env.DB.prepare("INSERT INTO cashouts (supplier_payment_id, fiat, fiat_cents, client_order_id, status, created_at, updated_at) VALUES (?, 'EUR', 10000, ?, 'queued', 'x', 'x') RETURNING id").bind(sp.id, `co-seed-${order.id}`).first<{ id: number }>();
  return cashout({ id: res!.id, clientOrderId: `co-seed-${order.id}` });
}
const soldHash = (clientOrderId: string) =>
  env.DB.prepare("SELECT tx_hash FROM sandbox_bank_ledger WHERE client_order_id = ? AND step = 'sold'").bind(clientOrderId).first<{ tx_hash: string | null }>();

describe("bankPass tx_hash", () => {
  it("is null when the order has no sent payout", async () => {
    await rates(4.27, 3.95);
    const c = await seededCashout(null);
    await bankPass(env, c, now);
    expect((await soldHash(c.clientOrderId))!.tx_hash).toBeNull();
  });
  it("records the treasury's payout hash on the sold row", async () => {
    await rates(4.27, 3.95);
    const c = await seededCashout({ status: "sent", ref: HASH });
    await bankPass(env, c, now);
    expect((await soldHash(c.clientOrderId))!.tx_hash).toBe(HASH);
    const res = await handleSandboxBank(new Request("https://x/api/sandbox/bank"), { ...env, SANDBOX: "1" } as unknown as Env);
    const body = await res.json<{ cashouts: { clientOrderId: string; steps: { step: string; txHash: string | null }[] }[] }>();
    expect(body.cashouts.find((x) => x.clientOrderId === c.clientOrderId)!.steps.map((s) => [s.step, s.txHash])).toEqual([["sold", HASH], ["withdrawn", null]]);
  });
  it("ignores a payout ref that is not a transaction hash", async () => {
    await rates(4.27, 3.95);
    const c = await seededCashout({ status: "sent", ref: "c" });
    await bankPass(env, c, now);
    expect((await soldHash(c.clientOrderId))!.tx_hash).toBeNull();
  });
});

describe("handleSandboxBank", () => {
  it("is 404 outside the sandbox", async () => {
    const res = await handleSandboxBank(new Request("https://x/api/sandbox/bank"), { ...env, SANDBOX: undefined } as unknown as Env);
    expect(res.status).toBe(404);
  });
  it("is 404 before any D1 read when the database would throw", async () => {
    const boom = { prepare: () => { throw new Error("D1 must not be touched"); } } as unknown as D1Database;
    const res = await handleSandboxBank(new Request("https://x/api/sandbox/bank"), { ...env, SANDBOX: undefined, DB: boom } as unknown as Env);
    expect(res.status).toBe(404);
  });
  it("lists cash-outs with their steps, newest first, masked accounts only", async () => {
    await rates(4.27, 3.95);
    await bankPass(env, cashout(), now);
    await bankPass(env, cashout({ id: 10, clientOrderId: "co-10" }), new Date(now.getTime() + 60_000));
    const res = await handleSandboxBank(new Request("https://x/api/sandbox/bank"), { ...env, SANDBOX: "1" } as unknown as Env);
    const body = await res.json<{ cashouts: { clientOrderId: string; steps: { step: string; accountMasked: string | null; rateSource: string | null }[] }[] }>();
    expect(body.cashouts.map((c) => c.clientOrderId)).toEqual(["co-10", "co-9"]);
    expect(body.cashouts[0].steps.map((s) => s.step)).toEqual(["sold", "withdrawn"]);
    expect(body.cashouts[0].steps.map((s) => s.rateSource)).toEqual(["nbp", null]);
    expect(body.cashouts[0].steps[1].accountMasked).toBe("owner's EUR account ••••4242");
  });
});
