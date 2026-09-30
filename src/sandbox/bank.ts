// src/sandbox/bank.ts — SHELL: arc-c4 fills in the body (keep the exports and signatures).
export interface BankCashout { id: number; fiat: "EUR" | "GBP"; amount: string; clientOrderId: string; status: "queued" | "sold"; createdAt: string }
export type BankResult =
  | { stage: "sold"; orderRef: string; soldUnits: string }
  | { stage: "withdrawn"; withdrawalRef: string; feeCents: number }
  | { stage: "withdraw_error"; error: string }
  | { status: "failed"; error: string };

/**
 * One pass over a live cash-out, like the Mac runner's runCashout: the results to post, in order (sold then withdrawn in one pass
 * is fine). Idempotent per clientOrderId through sandbox_bank_ledger's (client_order_id, step) key: a cash-out already sold in the
 * ledger returns its recorded sale instead of selling again. Withdraws only to the owner's own (masked) account.
 */
export async function bankPass(env: Env, c: BankCashout, now: Date = new Date()): Promise<BankResult[]> {
  const at = now.toISOString();
  const out: BankResult[] = [];
  if (c.status === "queued") {
    // Default: 1 USDC = amount / 0.88 at a flat rate; arc-c4 uses the live NBP rate with a simulated spread.
    const soldUnits = Math.ceil((Number(c.amount) / 0.88) * 1_000_000);
    await env.DB.prepare("INSERT OR IGNORE INTO sandbox_bank_ledger (cashout_id, client_order_id, step, fiat, usdc_units, ref, created_at) VALUES (?, ?, 'sold', ?, ?, ?, ?)")
      .bind(c.id, c.clientOrderId, c.fiat, soldUnits, `SIM-SELL-${c.id}`, at).run();
    const sold = await env.DB.prepare("SELECT usdc_units, ref FROM sandbox_bank_ledger WHERE client_order_id = ? AND step = 'sold'").bind(c.clientOrderId).first<{ usdc_units: number; ref: string }>();
    out.push({ stage: "sold", orderRef: sold!.ref, soldUnits: (sold!.usdc_units / 1_000_000).toFixed(6) });
  }
  const cents = Math.round(Number(c.amount) * 100);
  await env.DB.prepare("INSERT OR IGNORE INTO sandbox_bank_ledger (cashout_id, client_order_id, step, fiat, fiat_cents, ref, account_masked, created_at) VALUES (?, ?, 'withdrawn', ?, ?, ?, ?, ?)")
    .bind(c.id, c.clientOrderId, c.fiat, cents, `SIM-WD-${c.id}`, "****4242", at).run();
  out.push({ stage: "withdrawn", withdrawalRef: `SIM-WD-${c.id}`, feeCents: 100 });
  return out;
}
