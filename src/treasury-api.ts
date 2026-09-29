import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createEscalation } from "./escalations";
import { formatUnits } from "./money";
import { createTelegram, notifyOwner } from "./telegram";
import { sameSecret } from "./telegram-webhook";
import { listQueuedPayouts, recordPayoutResult } from "./treasury";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Endpoints for the wallet runner on the owner's machine. */
export async function handleTreasuryApi(request: Request, env: Env): Promise<Response> {
  const token = env.TREASURY_RUNNER_TOKEN;
  if (!token) return json(404, { error: "not configured" });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(given, token)) return json(401, { error: "unauthorized" });
  const path = new URL(request.url).pathname;

  if (path === "/api/treasury/payouts" && request.method === "GET") {
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
    const { payout, obligation } = done;
    if (status === "denied" || status === "failed") {
      // A "failed" run can hide a transfer that was broadcast, so the owner decides on both.
      try {
        const what = `Payout #${payout.id} (${formatUnits(payout.amount_units)} ${payout.token}, ${obligation.kind} obligation #${obligation.id})`;
        const detail = error ? `: ${error.slice(0, 200)}` : "";
        const refused = status === "failed" && error?.startsWith("runner rejected the payout");
        const summary = refused
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
    try {
      const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
      await treasury.notify(`Payout #${payout.id} for obligation #${obligation.id} ${status}${ref ? ` (ref ${ref})` : ""}${error ? `: ${error.slice(0, 200)}` : ""}.`);
    } catch (err) {
      console.error("could not tell the treasury about a payout result", err);
    }
    return json(200, { ok: true });
  }

  return json(404, { error: "not found" });
}
