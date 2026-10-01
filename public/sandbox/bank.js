// Mock bank ledger page. Data from GET /api/sandbox/bank.
// Every server-derived string (client order ids, refs, masked accounts) goes in with textContent, never innerHTML.
import { money } from "./text.js";

const EXPLORER = "https://explorer.testnet.arc.io";
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const RATE_SOURCE = { nbp: "NBP rate", fallback: "fallback rate (NBP unavailable)" };

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};
const usdc = (units) => `${(Number(units) / 1_000_000).toFixed(6)} USDC`;
const cell = (label, cls, ...kids) => h("td", { "data-label": label, class: cls }, ...kids);

function refCell(s) {
  const kids = [s.ref ? h("span", { text: String(s.ref) }) : "none"];
  if (typeof s.txHash === "string" && TX_HASH.test(s.txHash)) {
    kids.push(" ", h("a", { href: `${EXPLORER}/tx/${s.txHash}`, target: "_blank", rel: "noopener noreferrer", text: "USDC received from the treasury (explorer)" }));
  }
  return cell("Reference", "ref", ...kids);
}

function stepRow(c, s) {
  if (s.step === "sold") {
    const source = RATE_SOURCE[s.rateSource];
    const rate = Number.isFinite(Number(s.rate)) && s.rate !== null
      ? `${Number(s.rate).toFixed(4)} USDC per ${c.fiat ?? "unit"}${source ? `, ${source}` : ""}`
      : "unknown";
    return h("tr", {},
      cell("Step", "step", "Sold"),
      cell("Amount", "", s.usdcUnits === null || s.usdcUnits === undefined ? "unknown" : usdc(s.usdcUnits)),
      cell("Details", "", `Rate: ${rate}`),
      refCell(s),
      cell("Time", "", when(s.at)));
  }
  const amount = s.fiatCents === null || s.fiatCents === undefined ? "unknown" : money(Number(s.fiatCents), c.fiat ?? "");
  return h("tr", {},
    cell("Step", "step", s.step === "withdrawn" ? "Withdrawn" : String(s.step)),
    cell("Amount", "", amount),
    cell("Details", "", s.accountMasked ? `To ${s.accountMasked}` : ""),
    refCell(s),
    cell("Time", "", when(s.at)));
}

function cashoutSheet(c) {
  const steps = Array.isArray(c.steps) ? c.steps : [];
  const amount = c.amount !== null && c.amount !== undefined && c.fiat ? `${c.amount} ${c.fiat}` : "";
  const head = h("thead", {}, h("tr", {},
    ...["Step", "Amount", "Details", "Reference", "Time"].map((t) => h("th", { scope: "col", text: t }))));
  const body = h("tbody", {}, ...steps.map((s) => stepRow(c, s)));
  const sheet = h("article", { class: "sheet bank-cashout" },
    h("h2", { text: `Order ${c.clientOrderId}` }),
    h("p", { class: "bank-meta", text: amount ? `Cash-out of ${amount} (simulated)` : "Cash-out (simulated)" }),
    h("table", { class: "bank-table" }, head, body));
  if (steps.length && !steps.some((s) => s.step === "withdrawn")) {
    sheet.append(h("p", { class: "bank-note", text: "Sold. The withdrawal to the owner's account hasn't happened yet." }));
  }
  return sheet;
}

async function load() {
  const root = document.getElementById("ledger");
  const message = (text) => root.replaceChildren(h("p", { class: "bank-state", text }));
  let data;
  try {
    const res = await fetch("/api/sandbox/bank", { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return message("Ledger not available yet.");
    data = await res.json();
  } catch {
    return message("Ledger not available yet.");
  }
  const cashouts = Array.isArray(data?.cashouts) ? data.cashouts : [];
  if (!cashouts.length) return message("No cash-outs yet. They show up here once an order is paid out.");
  root.replaceChildren(...cashouts.map(cashoutSheet));
}

load();
