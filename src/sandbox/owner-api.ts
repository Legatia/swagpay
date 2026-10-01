// The sandbox owner panel's API: the owner's actions for one order, reached with the order token.
import { toPayRowForOrder, toPayState } from "../admin-data";
import { latestCashout, supplierPaymentForOrder } from "../back-office";
import { cancelSupplierPayment, cashOut, decideAsOwner, markSupplierPaid, retryCashoutWithdrawal } from "../owner-actions";
import { getOrderByToken, type OrderRow } from "../db";
import type { EscalationRow } from "../escalations";
import { suggestAnyVendors, suggestVendors, cityFromPlace } from "../vendors";
import { giveCost, COST_CURRENCIES, type CostCurrency } from "../telegram-webhook";
import type { OrderSpec } from "../order-spec";
import { warsawDate } from "../time";
import { getAgentByName } from "agents";
import { isSandbox } from "./config";
import { plnPer } from "../fx";
import { simulatedQuote } from "./printer";

export interface SandboxOwnerState {
  order: { id: number; status: string };
  /** Open escalations that concern this order: its own, plus orderless treasury ones whose payload points at this order's
   *  obligation or cash-out. `why` is the summary (it already says which rule stopped for a human). */
  pending: Array<{ id: number; kind: string; why: string; actions: Array<"approve" | "reject"> }>;
  /** The open cost request, with simulated quotes for the suggested printers (delivery city, else anywhere; screened/partner, up to 3). */
  cost: { escalationId: number; suggestions: Array<{ vendorId: number; name: string; city: string; quote: { currency: string; amount: number; label: string } | null }> } | null;
  /** The printer payment the owner makes by hand, with the dashboard's state label and allowed actions. */
  payment: { id: number; currency: string; amountCents: number; label: string; actions: Array<"cashout" | "retry" | "paid" | "cancel"> } | null;
  cashout: { id: number; status: string; fiat: string; amount: string; withdrawalRef: string | null } | null;
  printer: { lastStep: string | null; nextStep: string | null; nextAt: string | null };
}

export const OWNER_POSTS_PER_HOUR = 30;
const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: unknown, headers: HeadersInit = NO_STORE) => Response.json(body, { status, headers });
const notFound = () => json(404, { error: "not found" });
const bad = (message: string) => json(400, { ok: false, message });

/** Production makes these acknowledge-only (escalationButtons). */
const noticeKind = (kind: string) => kind === "payment" || kind === "system";

const parseSpec = (o: OrderRow): OrderSpec | null => {
  try { return o.spec_json ? (JSON.parse(o.spec_json) as OrderSpec) : null; } catch { return null; }
};

/** Open escalations about this order. Cost requests are not listed: `cost` carries them. */
async function pendingFor(env: Env, orderId: number): Promise<EscalationRow[]> {
  return (await env.DB
    .prepare(
      `SELECT * FROM escalations WHERE status = 'open' AND kind != 'cost' AND (
         order_id = ?1
         OR (order_id IS NULL AND (
           json_extract(payload_json, '$.obligationId') IN (SELECT id FROM obligations WHERE order_id = ?1)
           OR json_extract(payload_json, '$.cashoutId') IN (SELECT c.id FROM cashouts c JOIN supplier_payments sp ON sp.id = c.supplier_payment_id WHERE sp.order_id = ?1)
         ))
       ) ORDER BY id`,
    ).bind(orderId).all<EscalationRow>()).results;
}

async function printerState(env: Env, order: OrderRow): Promise<SandboxOwnerState["printer"]> {
  try {
    return await (await getAgentByName(env.OrderAgent, order.instance)).sandboxPrinterState();
  } catch {
    return { lastStep: null, nextStep: null, nextAt: null }; // an order the agent never saw
  }
}

async function ownerState(env: Env, order: OrderRow): Promise<SandboxOwnerState> {
  const pending = await pendingFor(env, order.id);
  const costRow = await env.DB
    .prepare("SELECT id FROM escalations WHERE order_id = ? AND kind = 'cost' AND status = 'open' ORDER BY id DESC LIMIT 1")
    .bind(order.id).first<{ id: number }>();
  let cost: SandboxOwnerState["cost"] = null;
  if (costRow) {
    const spec = parseSpec(order);
    const city = cityFromPlace(order.delivery_place);
    const methods = [...new Set((spec?.items ?? []).map((i) => i.method).filter((m): m is string => !!m))];
    let found = city ? await suggestVendors(env.DB, city, methods, 3) : [];
    if (!found.length) found = await suggestAnyVendors(env.DB, methods, 3); // unknown city or none there: the best printers anywhere
    cost = {
      escalationId: costRow.id,
      suggestions: found.map(({ vendor }) => ({ vendorId: vendor.id, name: vendor.name, city: vendor.city, quote: simulatedQuote(order, spec, vendor) })),
    };
  }
  const row = await toPayRowForOrder(env.DB, order.id);
  const st = row ? toPayState(row) : null;
  return {
    order: { id: order.id, status: order.status },
    pending: pending.map((e) => ({ id: e.id, kind: e.kind, why: e.summary, actions: noticeKind(e.kind) ? ["approve"] : ["approve", "reject"] })),
    cost,
    payment: row && st ? { id: row.payment.id, currency: row.payment.currency, amountCents: row.payment.amount_cents, label: st.label, actions: st.actions } : null,
    cashout: row?.cashout
      ? { id: row.cashout.id, status: row.cashout.status, fiat: row.cashout.fiat, amount: (row.cashout.fiat_cents / 100).toFixed(2), withdrawalRef: row.cashout.withdrawal_ref }
      : null,
    printer: await printerState(env, order),
  };
}

/** One row per accepted POST in sandbox_owner_calls; the 31st within an hour is refused and writes nothing. Domain refusals count. */
async function overRateLimit(env: Env, orderId: number): Promise<boolean> {
  const now = Date.now();
  const cutoff = new Date(now - 3_600_000).toISOString();
  await env.DB.prepare("DELETE FROM sandbox_owner_calls WHERE order_id = ? AND at < ?").bind(orderId, cutoff).run();
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sandbox_owner_calls WHERE order_id = ?").bind(orderId).first<{ n: number }>())?.n ?? 0;
  if (n >= OWNER_POSTS_PER_HOUR) return true;
  await env.DB.prepare("INSERT INTO sandbox_owner_calls (order_id, at) VALUES (?, ?)").bind(orderId, new Date(now).toISOString()).run();
  return false;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function handleSandboxOwner(request: Request, env: Env, token: string, action: string | null): Promise<Response> {
  if (!isSandbox(env)) return notFound();
  const order = await getOrderByToken(env.DB, token);
  if (!order) return notFound();

  if (!action) {
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    return json(200, await ownerState(env, order));
  }
  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  if (await overRateLimit(env, order.id)) return json(429, { ok: false, message: "Too many owner actions on this order. Try again in a while." }, { ...NO_STORE, "retry-after": "600" });

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("Send a JSON object.");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("Send a JSON object.");
  }
  const who = "sandbox";
  const result = (r: { ok: boolean; message: string }) => json(200, r);
  const sp = async () => supplierPaymentForOrder(env.DB, order.id);
  const noPayment = { ok: false, message: "This order has no printer payment yet." };

  switch (action) {
    case "cost": {
      const amount = body.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 9_999_999.99 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return bad("amount must be a positive number with at most two decimals.");
      if (!(COST_CURRENCIES as readonly unknown[]).includes(body.currency)) return bad(`currency must be one of ${COST_CURRENCIES.join(", ")}.`);
      const vendorId = body.vendorId;
      if (vendorId !== undefined && vendorId !== null && !(typeof vendorId === "number" && Number.isInteger(vendorId) && vendorId > 0)) return bad("vendorId must be a printer number.");
      const open = await env.DB.prepare("SELECT id FROM escalations WHERE order_id = ? AND kind = 'cost' AND status = 'open' ORDER BY id DESC LIMIT 1").bind(order.id).first<{ id: number }>();
      if (!open) return bad("No open cost request.");
      const maxUsd = Number((env as unknown as { SANDBOX_MAX_COST_USD?: string }).SANDBOX_MAX_COST_USD) || 5;
      const [perUnit, perUsd] = await Promise.all([plnPer(env.DB, body.currency as string), plnPer(env.DB, "USD")]);
      if (perUnit === null || perUsd === null) return bad(`No fresh NBP rate for ${perUnit === null ? body.currency : "USD"}; try again later.`);
      if ((amount * perUnit) / perUsd > maxUsd) return bad(`The sandbox caps the printer cost at $${maxUsd} (testnet faucet).`);
      const message = await giveCost(env, open.id, amount, str(body.note, 500), { currency: body.currency as CostCurrency, vendorId: (vendorId as number | null | undefined) ?? undefined });
      const after = await env.DB.prepare("SELECT status FROM escalations WHERE id = ?").bind(open.id).first<{ status: string }>();
      return result({ ok: after?.status !== "open", message });
    }
    case "decide": {
      const id = body.escalationId;
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return bad("escalationId must be a number.");
      if (body.decision !== "approve" && body.decision !== "reject") return bad("decision must be approve or reject.");
      const esc = (await pendingFor(env, order.id)).find((e) => e.id === id);
      if (!esc) return notFound();
      if (body.decision === "reject" && noticeKind(esc.kind)) return bad("This is a notice: acknowledge it.");
      return result(await decideAsOwner(env, id, body.decision, str(body.note, 500), who));
    }
    case "cashout": {
      const p = await sp();
      return result(p ? await cashOut(env, p.id, who) : noPayment);
    }
    case "cancel": {
      const p = await sp();
      return result(p ? await cancelSupplierPayment(env, p.id, str(body.note, 300), who) : noPayment);
    }
    case "paid": {
      const method = str(body.method, 20);
      if (!method) return bad("method is required: card, blik or transfer.");
      const p = await sp();
      if (!p) return result(noPayment);
      const date = str(body.date, 10) ?? warsawDate(new Date());
      return result(await markSupplierPaid(env, p.id, { method, reference: str(body.reference, 100), date, confirm: true }, who));
    }
    case "retry": {
      const p = await sp();
      const c = p ? await latestCashout(env.DB, p.id) : null;
      return result(c ? await retryCashoutWithdrawal(env, c.id, who) : { ok: false, message: "This order has no cash-out to retry." });
    }
    case "skip":
      try {
        return result(await (await getAgentByName(env.OrderAgent, order.instance)).sandboxSkip());
      } catch {
        return result({ ok: false, message: "Nothing to skip." }); // an order the agent never saw
      }
    default:
      return bad("Unknown action.");
  }
}
