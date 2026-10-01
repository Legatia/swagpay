import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { bankPass, handleSandboxBank, type BankCashout } from "../../src/sandbox/bank";

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
    const body = await res.json<{ cashouts: { clientOrderId: string; steps: { step: string; accountMasked: string | null }[] }[] }>();
    expect(body.cashouts.map((c) => c.clientOrderId)).toEqual(["co-10", "co-9"]);
    expect(body.cashouts[0].steps.map((s) => s.step)).toEqual(["sold", "withdrawn"]);
    expect(body.cashouts[0].steps[1].accountMasked).toBe("owner's EUR account ••••4242");
  });
});
