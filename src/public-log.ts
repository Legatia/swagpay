import { esc } from "./admin";
import { formatUnits } from "./money";

export interface PublicDecision {
  at: string;
  order: number | null;
  agent: "order" | "treasury";
  tool: string;
  reason: string;
  outcome: string;
}

/** Free model text on a public page: strip emails and phone-like runs; 0x addresses and hashes survive. */
export function redactReason(text: string): string {
  return text
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")
    .replace(/0x[0-9a-f]+|\+?\d[\d\s().-]{7,}\d/gi, (m) => (/^0x/i.test(m) ? m : "[phone]"));
}

/** Both agents' decisions, newest first: tool, reason and outcome only; never inputs. */
export async function listPublicDecisions(db: D1Database, limit = 100): Promise<PublicDecision[]> {
  const rows = (await db
    .prepare(
      `SELECT created_at AS at, order_id AS "order", 'order' AS agent, tool, reason, outcome FROM decisions
       UNION ALL
       SELECT created_at AS at, order_id AS "order", 'treasury' AS agent, tool, reason, outcome FROM treasury_decisions
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<PublicDecision>()).results;
  return rows.map((r) => ({ ...r, reason: redactReason(r.reason).slice(0, 300) }));
}

export interface Metrics {
  orders: Record<string, number>;
  received: { USDC: string; EURC: string };
  paidOut: { USDC: string; EURC: string };
  obligations: { settledByAgent: number; settledWithOwner: number; open: number };
  decisions: { total: number; escalated: number; blocked: number };
}

export async function computeMetrics(db: D1Database): Promise<Metrics> {
  const orders: Record<string, number> = {};
  for (const r of (await db.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all<{ status: string; n: number }>()).results) orders[r.status] = r.n;
  const sums = async (sql: string) => {
    const out = { USDC: "0.000000", EURC: "0.000000" };
    for (const r of (await db.prepare(sql).all<{ token: "USDC" | "EURC"; n: number }>()).results) if (r.token in out) out[r.token] = formatUnits(r.n);
    return out;
  };
  const obligations = await db
    .prepare(
      `SELECT COALESCE(SUM(status = 'paid' AND approved_by IS NULL), 0) AS agent,
              COALESCE(SUM(status = 'paid' AND approved_by = 'owner'), 0) AS owner,
              COALESCE(SUM(status IN ('open', 'approved', 'queued', 'failed', 'escalated')), 0) AS open
       FROM obligations`,
    )
    .first<{ agent: number; owner: number; open: number }>();
  const decisions = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(verdict = 'escalate'), 0) AS escalated, COALESCE(SUM(verdict = 'block'), 0) AS blocked
       FROM (SELECT verdict FROM decisions UNION ALL SELECT verdict FROM treasury_decisions)`,
    )
    .first<{ total: number; escalated: number; blocked: number }>();
  return {
    orders,
    received: await sums("SELECT token, SUM(amount_units) AS n FROM transfers WHERE request_id IS NOT NULL GROUP BY token"),
    paidOut: await sums("SELECT token, SUM(amount_units) AS n FROM payouts WHERE status = 'sent' GROUP BY token"),
    obligations: { settledByAgent: obligations?.agent ?? 0, settledWithOwner: obligations?.owner ?? 0, open: obligations?.open ?? 0 },
    decisions: { total: decisions?.total ?? 0, escalated: decisions?.escalated ?? 0, blocked: decisions?.blocked ?? 0 },
  };
}

export function renderLog(decisions: PublicDecision[], m: Metrics): string {
  const tile = (label: string, value: string) => `<div class="sheet"><span class="label">${esc(label)}</span><p><strong>${esc(value)}</strong></p></div>`;
  const rows = decisions
    .map((d) => `<tr><td>${esc(d.at.slice(0, 16).replace("T", " "))}</td><td>${d.order ?? "—"}</td><td>${esc(d.agent)}</td><td>${esc(d.tool)}</td><td>${esc(d.reason)}</td><td>${esc(d.outcome)}</td></tr>`)
    .join("");
  const ordersTotal = Object.values(m.orders).reduce((a, b) => a + b, 0);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decision log · Swagpay</title>
<link rel="stylesheet" href="/app.css"></head>
<body><main>
<span class="label">Swagpay</span>
<h1>What the agents decided</h1>
<p class="muted">Every action of the order agent and the treasury agent, with the reason it gave. Limits are enforced in code; anything above them goes to the owner.</p>
<div class="row">${tile("Orders", String(ordersTotal))}${tile("USDC received", m.received.USDC)}${tile("USDC paid out", m.paidOut.USDC)}</div>
<div class="row">${tile("Settled by the agent", String(m.obligations.settledByAgent))}${tile("Decisions / escalated", `${m.decisions.total} / ${m.decisions.escalated}`)}</div>
<section class="sheet"><h2>Decisions</h2><div style="overflow-x:auto"><table><thead><tr><th>When (UTC)</th><th>Order</th><th>Agent</th><th>Action</th><th>Reason</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section>
</main></body></html>`;
}
