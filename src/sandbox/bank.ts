// src/sandbox/bank.ts: the mock bank. Sells USDC at the NBP cross rate plus a simulated spread, withdraws to the owner's masked account.
import { plnPer } from "../fx";
import { isSandbox } from "./config";

export interface BankCashout { id: number; fiat: "EUR" | "GBP"; amount: string; clientOrderId: string; status: "queued" | "sold"; createdAt: string }
export type BankResult =
  | { stage: "sold"; orderRef: string; soldUnits: string }
  | { stage: "withdrawn"; withdrawalRef: string; feeCents: number }
  | { stage: "withdraw_error"; error: string }
  | { status: "failed"; error: string };

const SPREAD = 0.005;
// Used only when NBP rates are missing or stale (EUR/GBP in USD); the ledger shows it as a fallback rate (rateSource).
const FALLBACK_USD_PER: Record<"EUR" | "GBP", number> = { EUR: 1.08, GBP: 1.27 };
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ownerAccount = (fiat: "EUR" | "GBP") => `owner's ${fiat} account ••••4242`;

async function usdPer(env: Env, fiat: "EUR" | "GBP", now: Date): Promise<number> {
  const [f, usd] = await Promise.all([plnPer(env.DB, fiat, now), plnPer(env.DB, "USD", now)]);
  return f !== null && usd !== null ? f / usd : FALLBACK_USD_PER[fiat];
}

/**
 * One pass over a live cash-out, like the Mac runner's runCashout: the results to post, in order (sold then withdrawn in one pass
 * is fine). Idempotent per clientOrderId through sandbox_bank_ledger's (client_order_id, step) key: a cash-out already sold in the
 * ledger returns its recorded sale instead of selling again. Withdraws only to the owner's own (masked) account.
 */
export async function bankPass(env: Env, c: BankCashout, now: Date = new Date()): Promise<BankResult[]> {
  const at = now.toISOString();
  const out: BankResult[] = [];
  const read = (step: string) =>
    env.DB.prepare("SELECT usdc_units, fiat_cents, ref FROM sandbox_bank_ledger WHERE client_order_id = ? AND step = ?")
      .bind(c.clientOrderId, step).first<{ usdc_units: number | null; fiat_cents: number | null; ref: string }>();
  const fiatCents = Math.round(Number(c.amount) * 100);
  if (c.status === "queued") {
    const rate = (await usdPer(env, c.fiat, now)) * (1 + SPREAD);
    const units = Math.ceil(Number(c.amount) * rate * 1_000_000 - 1e-6);
    // The treasury's on-chain USDC payout for this order's printer cost: the USDC the mock bank "received". Null when none is recorded.
    const sent = await env.DB.prepare(
      `SELECT p.result_ref AS hash FROM cashouts c
         JOIN supplier_payments sp ON sp.id = c.supplier_payment_id
         JOIN obligations o ON o.order_id = sp.order_id AND o.kind = 'printer_cost' AND o.vendor_id IS NULL
         JOIN payouts p ON p.obligation_id = o.id AND p.status = 'sent'
        WHERE c.id = ? ORDER BY p.id DESC LIMIT 1`,
    ).bind(c.id).first<{ hash: string | null }>();
    const txHash = sent?.hash && TX_HASH.test(sent.hash) ? sent.hash : null;
    await env.DB.prepare("INSERT OR IGNORE INTO sandbox_bank_ledger (cashout_id, client_order_id, step, fiat, fiat_cents, usdc_units, rate, ref, tx_hash, created_at) VALUES (?, ?, 'sold', ?, ?, ?, ?, ?, ?, ?)")
      .bind(c.id, c.clientOrderId, c.fiat, fiatCents, units, rate, `SIM-SELL-${c.id}`, txHash, at).run();
    const sold = await read("sold");
    out.push({ stage: "sold", orderRef: sold!.ref, soldUnits: (sold!.usdc_units! / 1_000_000).toFixed(6) });
  }
  await env.DB.prepare("INSERT OR IGNORE INTO sandbox_bank_ledger (cashout_id, client_order_id, step, fiat, fiat_cents, ref, account_masked, created_at) VALUES (?, ?, 'withdrawn', ?, ?, ?, ?, ?)")
    .bind(c.id, c.clientOrderId, c.fiat, fiatCents, `SIM-WD-${c.id}`, ownerAccount(c.fiat), at).run();
  const wd = await read("withdrawn");
  out.push({ stage: "withdrawn", withdrawalRef: wd!.ref, feeCents: 0 });
  return out;
}

interface LedgerStep { step: string; fiatCents: number | null; usdcUnits: number | null; rate: number | null; ref: string | null; accountMasked: string | null; txHash: string | null; at: string; rateSource: "nbp" | "fallback" | null }

/** GET /api/sandbox/bank: the mock bank's public ledger (sandbox only). */
export async function handleSandboxBank(request: Request, env: Env): Promise<Response> {
  if (!isSandbox(env)) return new Response("not found", { status: 404 });
  if (request.method !== "GET") return new Response("not found", { status: 404 });
  const rows = (await env.DB.prepare(
    "SELECT cashout_id, client_order_id, step, fiat, fiat_cents, usdc_units, rate, ref, account_masked, tx_hash, created_at FROM sandbox_bank_ledger ORDER BY created_at DESC, id DESC LIMIT 200",
  ).all<{ cashout_id: number; client_order_id: string; step: string; fiat: string | null; fiat_cents: number | null; usdc_units: number | null; rate: number | null; ref: string | null; account_masked: string | null; tx_hash: string | null; created_at: string }>()).results;
  const byId = new Map<string, { id: number; clientOrderId: string; fiat: string | null; amount: string | null; steps: LedgerStep[] }>();
  for (const r of rows) {
    const entry = byId.get(r.client_order_id) ?? { id: r.cashout_id, clientOrderId: r.client_order_id, fiat: r.fiat, amount: r.fiat_cents === null ? null : (r.fiat_cents / 100).toFixed(2), steps: [] };
    const fallback = r.step === "sold" && r.rate !== null && (r.fiat === "EUR" || r.fiat === "GBP") && Math.abs(r.rate - FALLBACK_USD_PER[r.fiat] * (1 + SPREAD)) < 1e-9;
    const rateSource = r.step === "sold" ? (fallback ? "fallback" : "nbp") : null;
    entry.steps.push({ step: r.step, fiatCents: r.fiat_cents, usdcUnits: r.usdc_units, rate: r.rate, ref: r.ref, accountMasked: r.account_masked, txHash: r.tx_hash, at: r.created_at, rateSource });
    byId.set(r.client_order_id, entry);
  }
  const order: Record<string, number> = { sold: 0, withdrawn: 1 };
  const cashouts = [...byId.values()].slice(0, 50).map((c) => ({ ...c, steps: c.steps.sort((a, b) => (order[a.step] ?? 9) - (order[b.step] ?? 9)) }));
  return Response.json({ cashouts }, { headers: { "cache-control": "no-store" } });
}
