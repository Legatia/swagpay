import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createEscalation } from "./escalations";
import { formatUnits } from "./money";
import { createTelegram, notifyOwner } from "./telegram";
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

/** Endpoints for the wallet runner on the owner's machine. */
export async function handleTreasuryApi(request: Request, env: Env): Promise<Response> {
  const token = env.TREASURY_RUNNER_TOKEN;
  if (!token) return json(404, { error: "not configured" });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(given, token)) return json(401, { error: "unauthorized" });
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

  return json(404, { error: "not found" });
}
