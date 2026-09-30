import { createRpc, type RpcClient } from "./arc";
import { configWarnings } from "./admin-util";
import { latestCashout, runnerLastSeen, supplierPaymentForOrder, type CashoutRow, type SupplierPaymentRow } from "./back-office";
import { getOrderById, listDecisions, type DecisionRow, type OrderRow } from "./db";
import type { EscalationRow } from "./escalations";
import { plnPer, ratesFor } from "./fx";
import { listOffers, rankOffers } from "./offers";
import { isAddress } from "./money";
import { listPaymentRequests, type PaymentRequestRow, type TransferRow } from "./payments";
import type { QuoteRow } from "./quotes";
import { orderMargin, type ObligationRow, type PayoutRow } from "./treasury";
import { getVendor, vendorJobFor, type VendorJobRow, type VendorRow } from "./vendors";

export interface ToPayRow {
  payment: SupplierPaymentRow;
  order: { id: number; event_name: string; deliver_by: string };
  vendor: { id: number; name: string; how_to_pay: string | null } | null;
  /** The owner-path printer_cost obligation (vendor_id IS NULL) and its latest payout's status. */
  obligation: { id: number; status: string } | null;
  payoutStatus: string | null;
  cashout: CashoutRow | null;
}

export type ToPayAction = "cashout" | "retry" | "paid" | "cancel";

type ToPaySelect = SupplierPaymentRow & { event_name: string; deliver_by: string; vendor_name: string | null; how_to_pay: string | null };
const TO_PAY_SELECT = `SELECT sp.*, o.event_name, o.deliver_by, v.name AS vendor_name, v.how_to_pay
       FROM supplier_payments sp JOIN orders o ON o.id = sp.order_id LEFT JOIN vendors v ON v.id = sp.vendor_id`;

async function hydrateToPay(db: D1Database, r: ToPaySelect): Promise<ToPayRow> {
  const ob = await db
    .prepare("SELECT id, status FROM obligations WHERE order_id = ? AND kind = 'printer_cost' AND vendor_id IS NULL ORDER BY id DESC LIMIT 1")
    .bind(r.order_id).first<{ id: number; status: string }>();
  const payout = ob ? await db.prepare("SELECT status FROM payouts WHERE obligation_id = ? ORDER BY id DESC LIMIT 1").bind(ob.id).first<{ status: string }>() : null;
  const { event_name, deliver_by, vendor_name, how_to_pay, ...payment } = r;
  return {
    payment: payment as SupplierPaymentRow,
    order: { id: r.order_id, event_name, deliver_by },
    vendor: r.vendor_id === null ? null : { id: r.vendor_id, name: vendor_name ?? `#${r.vendor_id}`, how_to_pay },
    obligation: ob ?? null,
    payoutStatus: payout?.status ?? null,
    cashout: await latestCashout(db, r.id),
  };
}

export async function toPayRows(db: D1Database, now: Date = new Date()): Promise<ToPayRow[]> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  // A paid payment stays 24 hours after it was marked paid (updated_at), whatever date the owner entered.
  const rows = (await db
    .prepare(`${TO_PAY_SELECT}
       WHERE sp.status IN ('due', 'cashing_out', 'ready') OR (sp.status = 'paid' AND sp.updated_at > ?)
       ORDER BY o.deliver_by, sp.id`)
    .bind(since)
    .all<ToPaySelect>()).results;
  return Promise.all(rows.map((r) => hydrateToPay(db, r)));
}

/** The same row as Today shows, for one order's printer payment (null when it has none). */
export async function toPayRowForOrder(db: D1Database, orderId: number): Promise<ToPayRow | null> {
  const r = await db.prepare(`${TO_PAY_SELECT} WHERE sp.order_id = ?`).bind(orderId).first<ToPaySelect>();
  return r ? hydrateToPay(db, r) : null;
}

/** What the row says and which buttons it offers. Cash out only once the treasury's payout reached Kraken, and never after a sale. */
export function toPayState(r: ToPayRow): { label: string; actions: ToPayAction[]; showHow: boolean } {
  const p = r.payment;
  if (p.status === "paid") return { label: `paid${p.method ? ` (${p.method})` : ""}`, actions: [], showHow: false };
  if (p.status === "cancelled") return { label: "cancelled", actions: [], showHow: false };
  if (p.status === "ready") return { label: "ready to pay", actions: ["paid", "cancel"], showHow: true };
  if (p.status === "cashing_out") {
    if (r.cashout?.status === "failed") return { label: "withdrawal failed", actions: ["retry", "paid"], showHow: false };
    return { label: `cashing out (${r.cashout?.status ?? "queued"})`, actions: ["paid"], showHow: false };
  }
  if (r.payoutStatus === "sent") return { label: "ready to cash out", actions: ["cashout", "paid", "cancel"], showHow: false };
  if (r.obligation?.status === "settled") return { label: "the treasury won't move it: pay from your own funds", actions: ["paid", "cancel"], showHow: true };
  return { label: `waiting for the treasury (${r.obligation?.status ?? "no obligation"})`, actions: ["paid", "cancel"], showHow: false };
}

export interface MoneySummary {
  usdc: number | null;
  eurc: number | null;
  /** USDC the treasury sent to the payout account (Kraken) for printer payments not cashed out yet. */
  atKrakenUnits: number;
  customersOwe: Array<{ token: string; units: number }>;
  oweSuppliers: Array<{ currency: string; cents: number }>;
}

export async function moneySummary(env: Env, rpc?: Pick<RpcClient, "erc20Balance">): Promise<MoneySummary> {
  const client = rpc ?? (() => { try { return createRpc([env.ARC_RPC_URL, env.ARC_RPC_FALLBACK_URL].filter((u) => u)); } catch { return null; } })();
  const balance = async (token: string) => {
    if (!client?.erc20Balance || !isAddress(env.RECEIVING_ADDRESS)) return null;
    try { return await client.erc20Balance(token, env.RECEIVING_ADDRESS); } catch (err) { console.error("admin balance read failed", err); return null; }
  };
  const [usdc, eurc] = await Promise.all([balance(env.USDC_ADDRESS), balance(env.EURC_ADDRESS)]);
  const atKraken = await env.DB
    .prepare(
      `SELECT COALESCE(SUM(o.amount_units), 0) AS n FROM obligations o JOIN supplier_payments sp ON sp.order_id = o.order_id
       WHERE o.kind = 'printer_cost' AND o.vendor_id IS NULL AND o.status = 'paid'
         AND (sp.status = 'due' OR (sp.status = 'cashing_out'
           AND COALESCE((SELECT status FROM cashouts WHERE supplier_payment_id = sp.id ORDER BY id DESC LIMIT 1), 'queued') = 'queued'))`,
    ).first<{ n: number }>();
  const customersOwe = (await env.DB
    .prepare("SELECT token, SUM(amount_units - paid_units) AS units FROM payment_requests WHERE status = 'open' GROUP BY token ORDER BY token")
    .all<{ token: string; units: number }>()).results;
  const oweSuppliers = (await env.DB
    .prepare("SELECT currency, SUM(amount_cents) AS cents FROM supplier_payments WHERE status IN ('due', 'cashing_out', 'ready') GROUP BY currency ORDER BY currency")
    .all<{ currency: string; cents: number }>()).results;
  return { usdc, eurc, atKrakenUnits: atKraken?.n ?? 0, customersOwe, oweSuppliers };
}

/** Today's warnings: configuration, stale rates, and the wallet runner's health. */
export async function adminWarningsFull(env: Env, now: Date = new Date()): Promise<string[]> {
  const w = configWarnings(env);
  if (!(await ratesFor(env.DB, "USD", now))) w.push("Exchange rates are stale or missing: quotes are paused.");
  if (env.TREASURY_RUNNER_TOKEN) {
    const seen = await runnerLastSeen(env.DB);
    if (!seen || now.getTime() - Date.parse(seen) > 3_600_000) w.push(`The wallet runner last polled ${seen ? `at ${seen.slice(0, 16).replace("T", " ")} UTC` : "never"}: payouts and cash-outs wait until it runs.`);
  }
  const stuck = await env.DB.prepare("SELECT COUNT(*) AS n FROM cashouts WHERE status = 'queued' AND created_at < ?").bind(new Date(now.getTime() - 2 * 3_600_000).toISOString()).first<{ n: number }>();
  if (stuck?.n) w.push(`${stuck.n} cash-out(s) queued for over 2 hours.`);
  return w;
}

export const ORDERS_PER_PAGE = 50;

export interface OrderListRow {
  id: number;
  event_name: string;
  contact_name: string;
  status: string;
  created_at: string;
  price_cents: number | null;
  currency: string | null;
  cost_pln_grosze: number | null;
  token: string | null;
  received_units: number;
  cost_units: number;
  printer: string | null;
  printer_paid: string | null;
}

export async function ordersPage(db: D1Database, offset: number): Promise<OrderListRow[]> {
  return (await db
    .prepare(
      `SELECT o.id, o.event_name, o.contact_name, o.status, o.created_at,
              q.price_cents, q.currency, q.cost_pln_grosze,
              (SELECT token FROM payment_requests WHERE order_id = o.id ORDER BY id LIMIT 1) AS token,
              (SELECT COALESCE(SUM(MIN(paid_units, amount_units)), 0) FROM payment_requests WHERE order_id = o.id AND status != 'cancelled') AS received_units,
              (SELECT COALESCE(SUM(amount_units), 0) FROM obligations WHERE order_id = o.id AND kind = 'printer_cost') AS cost_units,
              v.name AS printer, sp.status AS printer_paid
       FROM orders o
       LEFT JOIN quotes q ON q.id = (SELECT id FROM quotes WHERE order_id = o.id ORDER BY (status = 'accepted') DESC, id DESC LIMIT 1)
       LEFT JOIN vendor_jobs j ON j.order_id = o.id LEFT JOIN vendors v ON v.id = j.vendor_id
       LEFT JOIN supplier_payments sp ON sp.order_id = o.id
       ORDER BY o.id DESC LIMIT ${ORDERS_PER_PAGE} OFFSET ?`,
    )
    .bind(offset)
    .all<OrderListRow>()).results;
}

export interface TreasuryDecisionRow {
  id: number;
  order_id: number | null;
  tool: string;
  reason: string;
  verdict: string;
  outcome: string;
  detail: string | null;
  created_at: string;
}

export interface Ledger {
  order: OrderRow;
  quotes: QuoteRow[];
  requests: PaymentRequestRow[];
  transfers: TransferRow[];
  job: VendorJobRow | null;
  vendor: VendorRow | null;
  obligations: ObligationRow[];
  payouts: PayoutRow[];
  payment: SupplierPaymentRow | null;
  /** The payment as Today shows it: state label and action forms. */
  toPay: ToPayRow | null;
  cashouts: CashoutRow[];
  margin: Awaited<ReturnType<typeof orderMargin>>;
  decisions: DecisionRow[];
  treasury: TreasuryDecisionRow[];
  escalations: EscalationRow[];
  /** Id of an open cost escalation for this order, or null. */
  openCost: number | null;
  /** Printer offers, cheapest landed cost first; `vendors` names the printers they come from. */
  offers: ReturnType<typeof rankOffers>;
  offerVendors: VendorRow[];
}

export async function orderLedger(db: D1Database, id: number): Promise<Ledger | null> {
  const order = await getOrderById(db, id);
  if (!order) return null;
  const list = async <T>(sql: string): Promise<T[]> => (await db.prepare(sql).bind(id).all<T>()).results;
  const job = await vendorJobFor(db, id);
  const payment = await supplierPaymentForOrder(db, id);
  const escalations = await list<EscalationRow>("SELECT * FROM escalations WHERE order_id = ? ORDER BY id DESC");
  const rawOffers = await listOffers(db, id);
  const rates = new Map<string, number | null>();
  for (const code of new Set(rawOffers.map((o) => o.currency))) rates.set(code, await plnPer(db, code));
  return {
    order,
    quotes: await list<QuoteRow>("SELECT * FROM quotes WHERE order_id = ? ORDER BY id"),
    requests: await listPaymentRequests(db, id),
    transfers: await list<TransferRow>("SELECT * FROM transfers WHERE request_id IN (SELECT id FROM payment_requests WHERE order_id = ?) ORDER BY block_number, log_index"),
    job,
    vendor: job ? await getVendor(db, job.vendor_id) : null,
    obligations: await list<ObligationRow>("SELECT * FROM obligations WHERE order_id = ? ORDER BY id"),
    payouts: await list<PayoutRow>("SELECT * FROM payouts WHERE obligation_id IN (SELECT id FROM obligations WHERE order_id = ?) ORDER BY id"),
    payment,
    toPay: payment ? await toPayRowForOrder(db, id) : null,
    cashouts: payment ? (await db.prepare("SELECT * FROM cashouts WHERE supplier_payment_id = ? ORDER BY id").bind(payment.id).all<CashoutRow>()).results : [],
    margin: await orderMargin(db, id),
    decisions: await listDecisions(db, id),
    treasury: await list<TreasuryDecisionRow>("SELECT * FROM treasury_decisions WHERE order_id = ? ORDER BY id DESC LIMIT 50"),
    escalations,
    openCost: escalations.find((e) => e.kind === "cost" && e.status === "open")?.id ?? null,
    offers: rankOffers(rawOffers, (c) => rates.get(c) ?? null, order.deliver_by),
    offerVendors: (await db
      .prepare("SELECT * FROM vendors WHERE status IN ('screened', 'partner') OR id IN (SELECT vendor_id FROM printer_offers WHERE order_id = ?) ORDER BY city, name")
      .bind(id).all<VendorRow>()).results,
  };
}

export interface SupplierListRow extends VendorRow {
  jobs: number;
  on_time: number;
  delivered: number;
  last_job: string | null;
}

export async function suppliersPage(db: D1Database): Promise<SupplierListRow[]> {
  return (await db
    .prepare(
      `SELECT v.*, COUNT(j.id) AS jobs, COALESCE(SUM(j.on_time), 0) AS on_time, COALESCE(SUM(j.delivered_at IS NOT NULL), 0) AS delivered, MAX(j.created_at) AS last_job
       FROM vendors v LEFT JOIN vendor_jobs j ON j.vendor_id = v.id
       WHERE v.status IN ('screened', 'partner', 'paused') OR j.id IS NOT NULL
       GROUP BY v.id ORDER BY v.city, v.status = 'partner' DESC, v.name`,
    )
    .all<SupplierListRow>()).results;
}
