// Testnet sandbox UI: banner, testnet pay helper, and the judge's "You are the owner" panel.
// Loaded as a module on every page; it does nothing unless the host is a sandbox host.
// Every server-derived string goes in with textContent / createTextNode, never innerHTML.
import { actionOutcome, actionsFor, isSandboxHost, judgeText, money } from "./text.js";

const FAUCET = "https://faucet.circle.com";
const EXPLORER = "https://explorer.testnet.arc.io";
const POLL_MS = 5000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CURRENCIES = ["PLN", "EUR", "GBP", "USD", "INR"];
const METHODS = [["card", "Card"], ["blik", "BLIK"], ["transfer", "Bank transfer"]];
const PAYMENT_BUTTONS = { cashout: "Cash out", retry: "Retry", paid: "Mark paid…", cancel: "Cancel" };
const GENERIC_NOTICE = "Update from the system.";

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}
const extLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", text });

function start() {
  if (!isSandboxHost(location)) return;
  if (document.getElementById("sbx-banner")) return; // loaded twice
  const css = h("link", { rel: "stylesheet", href: "/sandbox/sandbox.css" });
  document.head.append(css);
  document.documentElement.classList.add("sbx-on");

  const dialog = buildDialog();
  document.body.append(buildBanner(dialog), dialog);
  trackBannerHeight(css);

  const m = /^\/o\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname);
  if (m) orderPage(m[1]);
}

/* ---------- Banner and "How it works" ---------- */

function buildBanner(dialog) {
  const text = h("div", { class: "sbx-banner-text" },
    h("span", {}, h("strong", { text: "Testnet sandbox:" }), " no real money, printers are not contacted."));
  if (/^\/(new(\.html)?|design(\/.*)?)$/.test(location.pathname)) {
    text.append(h("span", { class: "sbx-tip", text: "Tip: choose a delivery date at least a week away." }));
  }
  const how = h("button", { type: "button", class: "sbx-linkish", text: "How it works", onclick: () => { if (!dialog.open) dialog.showModal(); } });
  return h("div", { id: "sbx-banner", class: "sbx-banner", role: "region", "aria-label": "Testnet sandbox" },
    text, h("div", { class: "sbx-banner-links" }, how, extLink(FAUCET, "Get test USDC")));
}

function buildDialog() {
  const close = h("button", { type: "submit", text: "Got it" });
  const dialog = h("dialog", { id: "sbx-how", class: "sbx-dialog", "aria-labelledby": "sbx-how-title" },
    h("h2", { id: "sbx-how-title", text: "How the sandbox works" }),
    h("ol", {},
      h("li", { text: "Design your swag with the agent and see a preview." }),
      h("li", { text: "Pay the deposit in testnet USDC on Arc." }),
      h("li", { text: "You act as the owner: give the printer cost and approve things in the owner panel." }),
      h("li", { text: "The printer is simulated: its steps move on by themselves, or press Skip ahead." }),
      h("li", { text: "Pay the balance, then confirm it was delivered." })),
    h("ul", {},
      h("li", { text: "Every printer step is simulated from published prices, scaled to 1% so a full order fits the faucet (a full order costs about 6 test USDC plus gas)." }),
      h("li", { text: "Pick a delivery date at least a week out; real lead times still apply." }),
      h("li", { text: "Pay exactly the amount shown." })),
    h("form", { method: "dialog" }, close));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  return dialog;
}

// The banner is 44 px, but a narrow screen or the tip line makes it wrap; keep the page below it.
function trackBannerHeight(css) {
  const banner = document.getElementById("sbx-banner");
  const apply = () => document.documentElement.style.setProperty("--sbx-h", `${Math.max(44, banner.offsetHeight)}px`);
  apply();
  css.addEventListener("load", apply); // the first measure can happen before the styles arrive
  if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(banner);
  else addEventListener("resize", apply);
}

/* ---------- Order page ---------- */

function orderPage(token) {
  const panel = h("section", { class: "sheet sbx-owner", id: "sbx-owner", "aria-label": "You are the owner" });
  const sections = {};
  const sigs = {};
  const header = [h("h2", { text: "You are the owner" }),
    h("p", { class: "sbx-sub", text: "In the real system this is the owner's back office. Here you press the buttons." })];
  panel.append(...header);
  for (const key of ["cost", "pending", "payment", "cashout", "printer", "empty"]) {
    sections[key] = h("div", { class: "sbx-section", "data-sbx": key });
    panel.append(sections[key]);
  }
  const result = h("p", { class: "sbx-result", role: "status", "aria-live": "polite" });
  panel.append(result);

  let inflight = false;
  let loading = false;
  let stopped = false;
  let ready = false; // the panel is attached after the first good answer, so a failed load shows nothing
  let paidFormOpen = false;
  let lastState = null;
  let paymentId = null;

  /* Pay helper and panel placement: order.js owns these pages and re-renders them, so look again after changes. */
  function ensure() {
    const payBox = document.getElementById("pay-box");
    if (payBox) {
      let helper = payBox.querySelector(":scope > .sbx-pay");
      if (!helper) {
        helper = buildPayHelper();
        payBox.prepend(helper);
      }
      syncExplorerLink(helper);
    }
    const statusBox = document.getElementById("status-box");
    if (ready && !stopped && statusBox && statusBox.nextElementSibling !== panel) statusBox.after(panel);
  }
  function buildPayHelper() {
    return h("div", { class: "sbx-pay" },
      h("p", {}, h("strong", { text: "Send exactly the amount shown, using the copy button. A different amount under 1 USDC can't be matched to your order and is ignored." })),
      h("p", { text: "Pay with testnet USDC on Arc Testnet (chain 5042002). Get up to 10 USDC a day at " }),
      h("p", { class: "sbx-network", text: "Add the network: RPC https://rpc.testnet.arc.network, chain id 5042002, symbol USDC." }),
      h("p", { class: "sbx-explorer", hidden: true }));
  }
  function syncExplorerLink(helper) {
    // The faucet link lives in the second line; build it once.
    const faucetLine = helper.children[1];
    if (!faucetLine.querySelector("a")) faucetLine.append(extLink(FAUCET, "faucet.circle.com"), ".");
    const holder = helper.querySelector(".sbx-explorer");
    const addr = (document.getElementById("pay-address")?.textContent ?? "").trim();
    const href = ADDRESS.test(addr) ? `${EXPLORER}/address/${addr}` : "";
    const current = holder.querySelector("a")?.getAttribute("href") ?? "";
    if (current === href) return;
    holder.replaceChildren();
    holder.hidden = !href;
    if (href) holder.append(extLink(href, "See the receiving address on the explorer"));
  }
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; ensure(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  ensure();

  /* Rendering. Each section is rebuilt only when its slice of the state changes, so a poll never wipes a half-typed form. */
  function setSection(key, slice, build) {
    const sig = JSON.stringify(slice ?? null);
    if (sigs[key] === sig) return;
    sigs[key] = sig;
    const node = sections[key];
    node.replaceChildren();
    if (slice) build(node, slice);
  }

  function render(state) {
    lastState = state;
    ready = true;
    const pending = Array.isArray(state.pending) ? state.pending : [];
    setSection("cost", state.cost, buildCost);
    setSection("pending", pending.length ? pending : null, buildPending);
    if (state.payment && paymentId !== state.payment.id) { paymentId = state.payment.id; paidFormOpen = false; }
    setSection("payment", state.payment ? { ...state.payment, paidFormOpen } : null, buildPayment);
    setSection("cashout", state.cashout, buildCashout);
    const p = state.printer;
    setSection("printer", p && (p.lastStep || p.nextStep || p.nextAt) ? p : null, buildPrinter);
    const nothing = !state.cost && !pending.length && !state.payment;
    setSection("empty", nothing ? { nothing } : null, (node) => node.append(h("p", { class: "sbx-empty", text: "Nothing needs the owner right now. The agents carry on." })));
    applyBusy();
    ensure();
  }

  function applyBusy() {
    panel.querySelectorAll("button, select, input").forEach((el) => { el.disabled = inflight; });
    panel.setAttribute("aria-busy", inflight ? "true" : "false");
  }

  function showResult(ok, message) {
    result.textContent = message;
    result.className = `sbx-result ${ok ? "ok" : "err"}`;
  }

  function button(label, onclick, secondary = false) {
    return h("button", { type: "button", class: secondary ? "sbx-secondary" : "", text: label, onclick });
  }

  /* cost */
  function buildCost(node, cost) {
    const suggestions = Array.isArray(cost.suggestions) ? cost.suggestions : [];
    node.append(h("h3", { text: "Printer cost needed" }));
    const vendor = h("select", { id: "sbx-vendor" });
    suggestions.forEach((s, i) => vendor.append(h("option", { value: String(s.vendorId), text: [s.name, s.city].filter(Boolean).join(", ") || `Printer ${i + 1}` })));
    const amount = h("input", { id: "sbx-amount", type: "number", inputmode: "decimal", min: "0.01", step: "0.01", required: true });
    const currency = h("select", { id: "sbx-currency" });
    CURRENCIES.forEach((c) => currency.append(h("option", { value: c, text: c })));
    const quoteLabel = h("span", { class: "sbx-quote-label" });
    const note = h("input", { id: "sbx-note", type: "text", maxlength: "500", autocomplete: "off" });
    const submit = h("button", { type: "submit", text: "Send cost" });

    const prefill = () => {
      const s = suggestions.find((x) => String(x.vendorId) === vendor.value);
      const q = s?.quote;
      if (q && Number.isFinite(Number(q.amount))) {
        amount.value = Number(q.amount).toFixed(2);
        if (CURRENCIES.includes(q.currency)) currency.value = q.currency;
        quoteLabel.textContent = judgeText(q.label) || "Simulated quote.";
      } else {
        quoteLabel.textContent = s ? "No simulated quote for this printer: enter your own." : "";
      }
    };
    vendor.addEventListener("change", prefill);
    if (suggestions.length) prefill(); else currency.value = "PLN";

    const form = h("form", { novalidate: true },
      suggestions.length ? h("label", {}, "Printer", vendor) : null,
      h("div", { class: "sbx-amount-row" },
        h("label", {}, "Amount", amount),
        h("label", {}, "Currency", currency)),
      quoteLabel,
      h("label", {}, "Note (optional)", note),
      h("div", { class: "sbx-buttons" }, submit));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = Number(amount.value);
      if (!amount.value.trim() || !Number.isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        showResult(false, "Enter a positive amount with at most two decimals.");
        return;
      }
      const body = { amount: value, currency: currency.value };
      if (suggestions.length && vendor.value) body.vendorId = Number(vendor.value);
      if (note.value.trim()) body.note = note.value.trim();
      act("cost", body);
    });
    node.append(form);
  }

  /* pending: escalations and notices */
  function buildPending(node, items) {
    node.append(h("h3", { text: "Waiting for you" }));
    for (const item of items) {
      const why = judgeText(item.why) || GENERIC_NOTICE;
      const buttons = h("div", { class: "sbx-buttons" });
      actionsFor(item).forEach((a, i) => buttons.append(button(a.label, () => act("decide", { escalationId: item.id, decision: a.decision }), i > 0)));
      node.append(h("div", { class: "sbx-item" }, h("p", { text: why }), buttons));
    }
  }

  /* payment */
  function buildPayment(node, payment) {
    node.append(h("h3", { text: `Printer payment: ${judgeText(payment.label) || "pending"}` }));
    if (Number.isFinite(Number(payment.amountCents)) && payment.currency) {
      node.append(h("p", { text: `Amount: ${money(Number(payment.amountCents), String(payment.currency))}` }));
    }
    const actions = (Array.isArray(payment.actions) ? payment.actions : []).filter((a) => PAYMENT_BUTTONS[a]);
    const buttons = h("div", { class: "sbx-buttons" });
    for (const a of actions) {
      if (a === "paid") {
        buttons.append(button(PAYMENT_BUTTONS.paid, () => { paidFormOpen = true; sigs.payment = null; render(lastState); }, true));
      } else {
        buttons.append(button(PAYMENT_BUTTONS[a], () => act(a, {}), a === "cancel"));
      }
    }
    if (actions.length) node.append(buttons);
    if (payment.paidFormOpen && actions.includes("paid")) node.append(buildPaidForm());
  }
  function buildPaidForm() {
    const method = h("select", { id: "sbx-method" });
    METHODS.forEach(([value, label]) => method.append(h("option", { value, text: `${label} (simulated)` })));
    const reference = h("input", { id: "sbx-reference", type: "text", maxlength: "100", autocomplete: "off" });
    const form = h("form", {},
      h("label", {}, "How did you pay the printer? (simulated)", method),
      h("label", {}, "Reference (optional)", reference),
      h("div", { class: "sbx-buttons" },
        h("button", { type: "submit", text: "Mark paid (simulated)" }),
        button("Back", () => { paidFormOpen = false; sigs.payment = null; render(lastState); }, true)));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = { method: method.value };
      if (reference.value.trim()) body.reference = reference.value.trim();
      act("paid", body);
    });
    return form;
  }

  /* cash-out */
  function buildCashout(node, c) {
    node.append(h("h3", { text: "Cash-out" }));
    const amount = [c.amount, c.fiat].filter(Boolean).join(" ");
    node.append(h("p", { text: `Status: ${c.status ?? "unknown"}${amount ? `, ${amount}` : ""}` }));
    if (c.withdrawalRef) node.append(h("p", {}, "Withdrawal reference: ", h("span", { class: "sbx-ref", text: String(c.withdrawalRef) })));
    node.append(h("p", {}, h("a", { href: "/sandbox/bank", text: "See it in the mock bank" })));
  }

  /* printer */
  function buildPrinter(node, p) {
    const when = p.nextAt ? formatTime(p.nextAt) : "";
    const next = p.nextStep ? `${p.nextStep}${when ? ` at ${when}` : ""}` : "none";
    node.append(h("h3", { text: "Printer (simulated)" }),
      h("p", { text: `Printer: last step ${p.lastStep ?? "none yet"}, next ${next}.` }),
      h("div", { class: "sbx-buttons" }, button("Skip ahead", () => act("skip", {}), true)));
  }
  function formatTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /* Talking to the server. */
  const url = `/api/o/${token}/sandbox/owner`;

  // The state, or null when it could not be read. A 404 means this is not a sandbox order, so the panel goes away.
  async function fetchState() {
    try {
      const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
      if (res.status === 404) { stopped = true; panel.remove(); return null; }
      return res.ok ? await res.json() : null;
    } catch {
      return null; // offline or a bad body: keep what is showing and try again on the next poll
    }
  }

  async function load() {
    if (loading || inflight || stopped) return;
    loading = true;
    try {
      const state = await fetchState();
      if (state && !inflight) render(state);
    } finally { loading = false; }
  }

  // One request at a time: every control is disabled until the answer is shown and the new state is drawn.
  async function act(action, body) {
    if (inflight) return;
    inflight = true;
    applyBusy();
    try {
      let status = 0;
      let data = null;
      try {
        const res = await fetch(`${url}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
        data = await res.json().catch(() => null);
      } catch {
        showResult(false, "Couldn't reach the server. Try again.");
        return;
      }
      const outcome = actionOutcome(status, data);
      showResult(outcome.ok, outcome.message || (outcome.ok ? "Done." : GENERIC_NOTICE));
      if (outcome.ok && action === "paid") paidFormOpen = false;
      const state = await fetchState();
      if (state) render(state);
    } finally {
      inflight = false;
      applyBusy();
    }
  }

  load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
}

start();
