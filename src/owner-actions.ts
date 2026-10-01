import { cashoutAmount, getCashout, getSupplierPayment, latestCashout, logAdminAction, queueCashout, retryWithdrawal, setSupplierPaymentStatus, type PayMethod } from "./back-office";
import { getAgentByName } from "agents";
import { getOrderById } from "./db";
import { isSandbox } from "./sandbox/config";
import { getEscalation } from "./escalations";
import { plnPer } from "./fx";
import { decide } from "./telegram-webhook";

/** The owner's money actions, shared by /admin and the sandbox owner panel. `ok` is false when nothing changed. */
export type ActionResult = { ok: boolean; message: string };

const METHODS: PayMethod[] = ["card", "blik", "transfer"];
const NOT_FOUND: ActionResult = { ok: false, message: "Not found." };
const refuse = (message: string): ActionResult => ({ ok: false, message });

/** who: the Access email for /admin, "sandbox" for the sandbox owner panel; it goes into admin_actions. */
export async function cashOut(env: Env, spId: number, who: string | null): Promise<ActionResult> {
  const log = (action: string, target: string, detail?: unknown) => logAdminAction(env.DB, { email: who, action, target, detail });
  const sp = await getSupplierPayment(env.DB, spId);
  if (!sp) return NOT_FOUND;
  if (sp.status === "cashing_out") return refuse("This payment is already cashing out.");
  if (sp.status !== "due") return refuse(`This payment is ${sp.status.replace("_", " ")}; there is nothing to cash out.`);
  const prior = await latestCashout(env.DB, sp.id);
  if (prior?.status === "failed" && prior.sold_units !== null) return refuse("Its USDC was already sold: use Retry withdrawal.");
  const sent = await env.DB
    .prepare(
      `SELECT 1 AS n FROM obligations o JOIN payouts p ON p.obligation_id = o.id
       WHERE o.order_id = ? AND o.kind = 'printer_cost' AND o.vendor_id IS NULL AND p.status = 'sent' LIMIT 1`,
    ).bind(sp.order_id).first();
  if (!sent) return refuse("The treasury hasn't sent this printer cost to Kraken yet.");
  const rates = new Map<string, number | null>();
  for (const code of new Set([sp.currency, "EUR"])) rates.set(code, await plnPer(env.DB, code));
  const amount = cashoutAmount({ currency: sp.currency, amountCents: sp.amount_cents }, (c) => (c === "PLN" ? 1 : rates.get(c) ?? null), {
    gbpEnabled: (env.KRAKEN_GBP_ENABLED as string) === "1",
    buffer: Number(env.CASHOUT_FX_BUFFER) >= 0 ? Number(env.CASHOUT_FX_BUFFER) : 0.02,
  });
  if (!amount) return refuse(`No fresh NBP rate for ${rates.get(sp.currency) === null ? sp.currency : "EUR"}: try again after the next hourly refresh.`);
  const c = await queueCashout(env.DB, sp.id, amount);
  if (!c) return refuse("This payment is already cashing out.");
  await log("cashout", `supplier_payment:${sp.id}`, { cashout: c.id, ...amount });
  return { ok: true, message: `Cash-out queued: ${(amount.fiatCents / 100).toFixed(2)} ${amount.fiat} to your ${amount.fiat} account. The wallet runner sells and withdraws it.` };
}

/** `date` is the raw YYYY-MM-DD string; it is stored as noon UTC. */
export async function markSupplierPaid(env: Env, spId: number, p: { method: string; reference: string | null; date: string; confirm: boolean }, who: string | null): Promise<ActionResult> {
  const sp = await getSupplierPayment(env.DB, spId);
  if (!sp) return NOT_FOUND;
  const method = p.method as PayMethod;
  if (!METHODS.includes(method)) return refuse("Choose card, blik or transfer.");
  const date = p.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00.000Z`))) return refuse("Give the date as YYYY-MM-DD.");
  if (sp.status === "cashing_out" && !p.confirm) return refuse("A cash-out is still in progress: tick 'money has arrived' to mark it paid anyway.");
  const ok = await setSupplierPaymentStatus(env.DB, sp.id, ["due", "cashing_out", "ready"], "paid", {
    method, reference: p.reference?.slice(0, 100) || null, paidAt: `${date}T12:00:00.000Z`,
  });
  if (!ok) return refuse(`This payment is already ${sp.status}.`);
  await logAdminAction(env.DB, { email: who, action: "paid", target: `supplier_payment:${sp.id}`, detail: { method } });
  if (isSandbox(env)) {
    // The simulated printer takes the job once the owner has paid it. Never fails the Paid.
    try {
      const order = await getOrderById(env.DB, sp.order_id);
      if (order) await (await getAgentByName(env.OrderAgent, order.instance)).sandboxStartPrinter();
    } catch (err) {
      console.error("could not start the simulated printer", err);
    }
  }
  return { ok: true, message: `Printer payment for order ${sp.order_id} marked paid (${method}).` };
}

export async function cancelSupplierPayment(env: Env, spId: number, note: string | null, who: string | null): Promise<ActionResult> {
  const sp = await getSupplierPayment(env.DB, spId);
  if (!sp) return NOT_FOUND;
  const ok = await setSupplierPaymentStatus(env.DB, sp.id, ["due", "ready"], "cancelled", { note: note?.slice(0, 300) || null });
  if (!ok) return refuse(sp.status === "cashing_out" ? "A cash-out is in progress: wait for it, then cancel." : `This payment is already ${sp.status}.`);
  await logAdminAction(env.DB, { email: who, action: "cancel", target: `supplier_payment:${sp.id}` });
  return { ok: true, message: `Printer payment for order ${sp.order_id} cancelled.` };
}

export async function retryCashoutWithdrawal(env: Env, cashoutId: number, who: string | null): Promise<ActionResult> {
  const c = await getCashout(env.DB, cashoutId);
  if (!c) return NOT_FOUND;
  if (!(await retryWithdrawal(env.DB, c.id))) {
    const sp = await getSupplierPayment(env.DB, c.supplier_payment_id);
    return refuse(`Cash-out #${c.id} can't be retried (it is ${c.status}${sp && sp.status !== "cashing_out" ? `; its printer payment is ${sp.status}` : ""}).`);
  }
  await logAdminAction(env.DB, { email: who, action: "retry_withdrawal", target: `cashout:${c.id}` });
  return { ok: true, message: `Cash-out #${c.id} will retry the withdrawal on the runner's next poll.` };
}

/** Goes through decide(), like Telegram. An unknown escalation answers with decide()'s own reply, not "Not found.". */
export async function decideAsOwner(env: Env, escalationId: number, decision: "approve" | "reject", note: string | null, who: string | null): Promise<ActionResult> {
  const before = await getEscalation(env.DB, escalationId);
  const reply = await decide(env, escalationId, decision === "approve" ? "approved" : "rejected", note?.slice(0, 500) || null);
  // Audit only a decision this request made: decide() also answers "already decided", "doesn't exist" and "needs a price".
  const after = before?.status === "open" ? await getEscalation(env.DB, escalationId) : null;
  const decided = !!after && after.status !== "open";
  if (decided) await logAdminAction(env.DB, { email: who, action: decision, target: `escalation:${escalationId}`, detail: { reply } });
  return { ok: decided, message: reply };
}
