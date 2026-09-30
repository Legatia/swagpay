import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createEscalation } from "./escalations";
import { formatUnits } from "./money";
import { getSupplierPayment, liveCashouts, recordCashoutFailed, recordCashoutSold, recordCashoutWithdrawn, recordWithdrawError, touchRunner, type CashoutRow } from "./back-office";
import { ADMIN_URL, createTelegram, notifyOwner } from "./telegram";
import { sameSecret } from "./telegram-webhook";
import { listQueuedPayouts, payoutsToWithhold, recordPayoutResult, type ObligationRow, type PayoutRow } from "./treasury";
import { getVendor } from "./vendors";

/** The error a withheld payout is recorded with; reportResult gives it its own summary. */
const WITHHELD = "withheld: ";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * After a recorded result: a denied or failed payout goes to the owner, who decides any retry; a printer's sent payout is a notice
 * to the owner; the treasury hears every result. Never throws.
 */
async function reportResult(
  env: Env, done: { payout: PayoutRow; obligation: ObligationRow }, status: "sent" | "denied" | "failed", ref: string | null, error: string | null,
): Promise<void> {
  const { payout, obligation } = done;
  if (status === "denied" || status === "failed") {
    // A "failed" run can hide a transfer that was broadcast, so the owner decides on both.
    try {
      const what = `Payout #${payout.id} (${formatUnits(payout.amount_units)} ${payout.token}, ${obligation.kind} obligation #${obligation.id})`;
      const detail = error ? `: ${error.slice(0, 200)}` : "";
      const refused = status === "failed" && error?.startsWith("runner rejected the payout");
      // Withheld before the runner's fetch; best-effort only for a batch the runner fetched just before.
      const withheld = status === "failed" && error?.startsWith(WITHHELD);
      const summary = withheld
        ? `The wallet runner was not given payout #${payout.id} (${formatUnits(payout.amount_units)} ${payout.token}, ${obligation.kind} obligation #${obligation.id}): ${error!.slice(WITHHELD.length)}. If the runner fetched it just before, it may still have gone out: check the wallet history. Approve to retry once the printer is registered again, or reject to settle it by hand.`
        : refused
        ? `The wallet runner refused payout #${payout.id} (${formatUnits(payout.amount_units)} ${payout.token}, ${obligation.kind} obligation #${obligation.id}): ${error}. Nothing was sent. Check the obligation, then approve to let the treasury agent try again or reject to settle it by hand.`
        : status === "denied"
        ? `Circle's spending limit refused payout #${payout.id} (${formatUnits(payout.amount_units)} ${payout.token}, ${obligation.kind} obligation #${obligation.id})${detail}. Check the agent wallet's transaction history before you approve a retry. Raise the limit with \`circle wallet limit\` (OTP) and approve to retry, or reject and pay by hand.`
        : `${what} failed${detail}. The transfer may still have gone out: check the agent wallet's transaction history before you approve a retry; reject to settle it by hand.`;
      const e = await createEscalation(env.DB, {
        orderId: null, kind: "approval", summary,
        payload: { obligationId: obligation.id, payoutId: payout.id },
      });
      await notifyOwner(env.DB, createTelegram(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_OWNER_CHAT_ID, e);
    } catch (err) {
      console.error("could not escalate a payout result", err);
    }
  }
  if (status === "sent" && obligation.vendor_id !== null) {
    // The owner sees the printer's money leave. A payment notice is acknowledge-only and never reaches the treasury, so it may name the printer.
    try {
      const vendor = await getVendor(env.DB, obligation.vendor_id);
      const e = await createEscalation(env.DB, {
        orderId: obligation.order_id, kind: "payment",
        summary: `Order ${obligation.order_id}: printer #${obligation.vendor_id}${vendor ? ` ${vendor.name}` : ""} milestone #${obligation.id} paid, ${formatUnits(payout.amount_units)} ${payout.token}${ref ? ` (ref ${ref})` : ""}.`,
        payload: { obligationId: obligation.id, payoutId: payout.id },
      });
      await notifyOwner(env.DB, createTelegram(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_OWNER_CHAT_ID, e);
    } catch (err) {
      console.error("could not tell the owner a printer was paid", err);
    }
  }
  try {
    const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
    await treasury.notify(`Payout #${payout.id} for obligation #${obligation.id} ${status}${ref ? ` (ref ${ref})` : ""}${error ? `: ${error.slice(0, 200)}` : ""}.`);
  } catch (err) {
    console.error("could not tell the treasury about a payout result", err);
  }
}

/** Tells the owner how a cash-out ended. Only the order number, the amount and the dashboard link: never the printer or how_to_pay. Never throws. */
async function tellOwnerCashout(env: Env, c: CashoutRow, what: "withdrawn" | "failed" | "withdraw_exhausted"): Promise<void> {
  try {
    const sp = await getSupplierPayment(env.DB, c.supplier_payment_id);
    const order = sp?.order_id ?? "?";
    const link = `${ADMIN_URL}/orders/${order}`;
    const amount = `${(c.fiat_cents / 100).toFixed(2)} ${c.fiat}`;
    const summary = what === "withdrawn"
      ? `${amount} withdrawn to your ${c.fiat} account for order ${order} (cash-out #${c.id}${c.withdrawal_ref ? `, ref ${c.withdrawal_ref}` : ""}). Pay the printer, then press Paid: ${link}`
      : what === "failed"
        ? `Cash-out #${c.id} for order ${order} failed: ${c.error ?? "unknown error"}. ${c.sold_units === null ? "Nothing was sold; you can cash out again" : "Its USDC was sold: use Retry withdrawal, or withdraw in the Kraken app and press Paid"}: ${link}`
        : `The withdrawal for cash-out #${c.id} failed 3 times (${c.error ?? "unknown error"}). Its USDC is sold and the ${c.fiat} is on Kraken: use Retry withdrawal, or withdraw in the Kraken app and press Paid: ${link}`;
    const e = await createEscalation(env.DB, { orderId: null, kind: what === "withdrawn" ? "payment" : "system", summary, payload: { cashoutId: c.id } });
    await notifyOwner(env.DB, createTelegram(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_OWNER_CHAT_ID, e);
  } catch (err) {
    console.error("could not tell the owner about a cash-out", err);
  }
}

/** Endpoints for the wallet runner on the owner's machine. */
export async function handleTreasuryApi(request: Request, env: Env): Promise<Response> {
  const token = env.TREASURY_RUNNER_TOKEN;
  if (!token) return json(404, { error: "not configured" });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(given, token)) return json(401, { error: "unauthorized" });
  // Any authenticated poll counts as the runner being alive.
  await touchRunner(env.DB);
  const path = new URL(request.url).pathname;

  if (path === "/api/treasury/payouts" && request.method === "GET") {
    // A printer paused or registered elsewhere after its payout was queued: the runner never gets it, and the owner decides.
    for (const w of await payoutsToWithhold(env.DB)) {
      const error = `${WITHHELD}printer #${w.vendorId} is no longer a partner at this address and chain`;
      const done = await recordPayoutResult(env.DB, w.payoutId, { status: "failed", error });
      if (done) await reportResult(env, done, "failed", null, error);
    }
    const payouts = await listQueuedPayouts(env.DB);
    return json(200, {
      payouts: payouts.map((p) => ({
        id: p.id, obligationId: p.obligation_id, method: p.method, chain: p.chain, token: p.token,
        amount: formatUnits(p.amount_units), destination: p.destination, idempotencyKey: p.idempotency_key,
      })),
    });
  }

  const m = /^\/api\/treasury\/payouts\/(\d{1,9})\/result$/.exec(path);
  if (m && request.method === "POST") {
    let body: { status?: unknown; ref?: unknown; error?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const status = body?.status;
    if (status !== "sent" && status !== "denied" && status !== "failed") return json(400, { error: "status must be sent, denied or failed" });
    const ref = typeof body.ref === "string" ? body.ref.slice(0, 200) : null;
    const error = typeof body.error === "string" ? body.error.slice(0, 500) : null;
    const done = await recordPayoutResult(env.DB, Number(m[1]), { status, ref, error });
    if (!done) return json(409, { error: "payout is not queued" });
    await reportResult(env, done, status, ref, error);
    return json(200, { ok: true });
  }

  if (path === "/api/treasury/cashouts" && request.method === "GET") {
    const rows = await liveCashouts(env.DB);
    return json(200, { cashouts: rows.map((c) => ({ id: c.id, fiat: c.fiat, amount: (c.fiat_cents / 100).toFixed(2), clientOrderId: c.client_order_id, status: c.status, createdAt: c.created_at })) });
  }

  const cm = /^\/api\/treasury\/cashouts\/(\d{1,9})\/result$/.exec(path);
  if (cm && request.method === "POST") {
    let b: Record<string, unknown>;
    try { b = (await request.json()) as Record<string, unknown>; } catch { return json(400, { error: "body must be JSON" }); }
    const id = Number(cm[1]);
    const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    if (b.stage === "sold") {
      const sold = typeof b.soldUnits === "string" && /^\d{1,12}\.\d{1,6}$/.test(b.soldUnits) ? Math.round(Number(b.soldUnits) * 1_000_000) : null;
      if (!sold) return json(400, { error: "soldUnits must be a positive decimal" });
      return (await recordCashoutSold(env.DB, id, { orderRef: str(b.orderRef, 100), soldUnits: sold })) ? json(200, { ok: true }) : json(409, { error: "cash-out is not queued" });
    }
    if (b.stage === "withdrawn") {
      const fee = b.feeCents === undefined || b.feeCents === null ? null : Number.isSafeInteger(b.feeCents) && (b.feeCents as number) >= 0 ? (b.feeCents as number) : undefined;
      if (fee === undefined) return json(400, { error: "feeCents must be a non-negative integer" });
      const done = await recordCashoutWithdrawn(env.DB, id, { withdrawalRef: str(b.withdrawalRef, 100), feeCents: fee });
      if (!done) return json(409, { error: "cash-out is not sold" });
      await tellOwnerCashout(env, done, "withdrawn");
      return json(200, { ok: true });
    }
    if (b.stage === "withdraw_error") {
      const r = await recordWithdrawError(env.DB, id, str(b.error, 500) ?? "withdrawal failed");
      if (!r) return json(409, { error: "cash-out is not sold" });
      if (r.exhausted) await tellOwnerCashout(env, r.row, "withdraw_exhausted");
      return json(200, { ok: true });
    }
    if (b.status === "failed") {
      const done = await recordCashoutFailed(env.DB, id, str(b.error, 500) ?? "failed");
      if (!done) return json(409, { error: "cash-out is not live" });
      await tellOwnerCashout(env, done, "failed");
      return json(200, { ok: true });
    }
    return json(400, { error: "stage must be sold, withdrawn or withdraw_error, or status failed" });
  }

  return json(404, { error: "not found" });
}
