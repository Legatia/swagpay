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

/** Free model text on a public page: strip emails, phone-like runs, currency amounts and wallet addresses; tx hashes, dates and bare numbers survive. */
export function redactReason(text: string): string {
  return text
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")
    // A lookahead, not \b, ends the currency: \b never matches after "zł" (ł is not an ASCII word character).
    .replace(/\b\d+(?:[.,]\d+)*\s*(?:USDC|EURC|PLN|USD|EUR|zł)(?![\p{L}\p{N}_])/giu, "[amount]")
    // The whole hex run is matched, so only a 40-hex one is an address; a 64-hex tx hash survives.
    .replace(/0x[0-9a-f]+|\+\d[\d\s()-]{7,}\d|\b\d{3}[\s-]\d{3}[\s-]\d{3}\b|\b\d{9,}\b/gi, (m) => (/^0x/i.test(m) ? (m.length === 42 ? "[address]" : m) : "[phone]"))
    // Currency first ("USDC 257.50", "€12"); after the addresses, so "USD 0x…" can't eat an address's leading 0.
    .replace(/(?:\b(?:USDC|EURC|PLN|USD|EUR)|[$€])\s*\d+(?:[.,]\d+)*/giu, "[amount]");
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

/** settledWithOwner: paid after the owner's approval, or settled by the owner by hand. open excludes settled (and the unused cancelled). */
export interface Metrics {
  orders: Record<string, number>;
  received: { USDC: string; EURC: string };
  paidOut: { USDC: string; EURC: string };
  obligations: { settledByAgent: number; settledWithOwner: number; open: number };
  decisions: { total: number; escalated: number; blocked: number };
  /** Counts only: no vendor name, city or address ever reaches a public page. onTimeRate is a percentage of delivered jobs, or null when none. */
  vendors: { cities: number; screened: number; partners: number; jobs: number; paidToVendors: { USDC: string }; onTimeRate: number | null };
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
              COALESCE(SUM((status = 'paid' AND approved_by = 'owner') OR status = 'settled'), 0) AS owner,
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
  const vendors = await db
    .prepare(
      `SELECT (SELECT COUNT(DISTINCT city) FROM vendors WHERE status IN ('screened', 'partner')) AS cities,
              (SELECT COUNT(*) FROM vendors WHERE status = 'screened') AS screened,
              (SELECT COUNT(*) FROM vendors WHERE status = 'partner') AS partners,
              (SELECT COUNT(*) FROM vendor_jobs WHERE status <> 'proposed') AS jobs,
              (SELECT COALESCE(SUM(p.amount_units), 0) FROM payouts p JOIN obligations o ON o.id = p.obligation_id
                WHERE p.status = 'sent' AND p.token = 'USDC' AND o.vendor_id IS NOT NULL) AS paid,
              (SELECT COUNT(*) FROM vendor_jobs WHERE status = 'delivered' AND on_time IS NOT NULL) AS delivered,
              (SELECT COUNT(*) FROM vendor_jobs WHERE status = 'delivered' AND on_time = 1) AS on_time`,
    )
    .first<{ cities: number; screened: number; partners: number; jobs: number; paid: number; delivered: number; on_time: number }>();
  return {
    orders,
    received: await sums("SELECT token, SUM(amount_units) AS n FROM transfers WHERE request_id IS NOT NULL GROUP BY token"),
    paidOut: await sums("SELECT token, SUM(amount_units) AS n FROM payouts WHERE status = 'sent' GROUP BY token"),
    obligations: { settledByAgent: obligations?.agent ?? 0, settledWithOwner: obligations?.owner ?? 0, open: obligations?.open ?? 0 },
    decisions: { total: decisions?.total ?? 0, escalated: decisions?.escalated ?? 0, blocked: decisions?.blocked ?? 0 },
    vendors: {
      cities: vendors?.cities ?? 0,
      screened: vendors?.screened ?? 0,
      partners: vendors?.partners ?? 0,
      jobs: vendors?.jobs ?? 0,
      paidToVendors: { USDC: formatUnits(vendors?.paid ?? 0) },
      onTimeRate: vendors?.delivered ? Math.round((100 * vendors.on_time) / vendors.delivered) : null,
    },
  };
}

export function renderLog(decisions: PublicDecision[], m: Metrics): string {
  const tile = (label: string, value: string) => `<div class="stat"><span class="label">${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  const usdc = (units: string) => `${Number(units).toFixed(2)}`;
  const rows = decisions.length
    ? decisions
      .map((d) => `<tr><td class="when">${esc(d.at.slice(0, 16).replace("T", " "))}</td><td>${d.order ?? "—"}</td><td>${esc(d.agent)}</td><td>${esc(d.tool.replace(/_/g, " "))}</td><td>${esc(d.reason)}</td><td>${esc(d.outcome)}</td></tr>`)
      .join("")
    : `<tr><td colspan="6" class="muted">No decisions yet. They appear here as the agents work.</td></tr>`;
  const ordersTotal = Object.values(m.orders).reduce((a, b) => a + b, 0);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decision log · Swagpay</title>
<link rel="icon" type="image/svg+xml" href="/mark.svg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&family=IBM+Plex+Mono:wght@400&display=swap">
<link rel="stylesheet" href="/app.css"></head>
<body><main>
<a class="site-logo" href="/"><picture><source media="(prefers-color-scheme: dark)" srcset="/logo-on-dark.svg"><img src="/logo.svg" alt="Swagpay" width="298" height="80"></picture></a>
<span class="label">Public decision log</span>
<h1>What the agents decided</h1>
<p class="muted">Every action of the order agent and the treasury agent, with the reason it gave. Spending limits are enforced in code; anything above them goes to the owner. Amounts and addresses in reasons are masked.</p>
<div class="stats">${tile("Orders", String(ordersTotal))}${tile("USDC received", usdc(m.received.USDC))}${tile("USDC paid out", usdc(m.paidOut.USDC))}${tile("Settled by the agent", String(m.obligations.settledByAgent))}${tile("Decisions", String(m.decisions.total))}${tile("Escalated to the owner", String(m.decisions.escalated))}</div>
<h2>Vendor network</h2>
<div class="stats">${tile("Cities", String(m.vendors.cities))}${tile("Screened printers", String(m.vendors.screened))}${tile("Partner printers", String(m.vendors.partners))}${tile("Printer jobs", String(m.vendors.jobs))}${tile("USDC paid to printers", usdc(m.vendors.paidToVendors.USDC))}${tile("On time", m.vendors.onTimeRate === null ? "—" : `${m.vendors.onTimeRate}%`)}</div>
<section class="sheet"><h2>Decisions</h2><div class="table-wrap"><table class="log-table"><thead><tr><th>When (UTC)</th><th>Order</th><th>Agent</th><th>Action</th><th>Reason</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section>
</main></body></html>`;
}
