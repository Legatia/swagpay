const token = location.pathname.split("/").pop();
const $ = (id) => document.getElementById(id);
let lastThreadLength = -1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const warsaw = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" });
const money = (n) => Number(n).toFixed(2);

const STEPS = ["Details", "Quote", "Deposit", "Printing", "Balance", "Delivery"];

/** Where the order stands and what the host does next. */
function statusFor(order, quote, missing) {
  const place = order.deliveryPlace;
  switch (order.status) {
    case "quoted":
      if (quote && quote.status === "open") return { step: 1, title: "Your quote is ready", text: "Check it below and accept it before it expires. The deposit request follows right away." };
      return { step: 1, title: "A new quote is on its way", text: "The last quote is no longer valid, so the agent is preparing a new one." };
    case "deposit_pending":
      return { step: 2, title: "Pay the deposit", text: "Send the deposit in stablecoins on Arc (details below). We confirm it automatically, usually within a minute or two." };
    case "deposit_paid":
      return { step: 3, title: "Deposit received: your swag is being printed", text: "We book a local printer now. When the job is printed, the balance request appears here." };
    case "balance_pending":
      return { step: 4, title: "Printed: pay the balance", text: "Your swag is printed. Send the balance (details below) and we deliver it." };
    case "balance_paid":
      return { step: 5, title: "Paid in full: delivery is next", text: `Your swag is on its way to ${place}. Press "We received it" when it arrives.` };
    case "closed":
      return { step: 6, title: "Delivered. Thank you!", text: "This order is closed. We hope the event goes great." };
    default:
      if (missing.length) return { step: 0, title: "Tell the agent what you need", text: "Answer the agent's questions in the chat and upload your artwork below. You get a price as soon as the order is complete." };
      return { step: 0, title: "Getting your price", text: "Your order is complete. We check the price with a local printer; the quote appears here, usually within a few hours." };
  }
}

function renderStatus(order, quote, missing) {
  const s = statusFor(order, quote, missing);
  $("status-box").hidden = false;
  $("steps").replaceChildren(...STEPS.map((name, i) => el("span", i < s.step ? "done" : i === s.step ? "current" : "", "")));
  $("step-label").textContent = s.step >= STEPS.length ? "Complete" : `Step ${s.step + 1} of ${STEPS.length} · ${STEPS[s.step]}`;
  $("status-title").textContent = s.title;
  $("status-text").textContent = s.text;
  $("status-chat").hidden = s.step !== 0;
}

function renderSpec(spec, missing) {
  const box = $("spec");
  box.replaceChildren();
  if (!spec.items.length) box.textContent = "Nothing yet. The agent fills this in as you talk.";
  for (const item of spec.items) {
    const sizes = item.sizes ? " · " + Object.entries(item.sizes).map(([s, n]) => `${s} ${n}`).join(", ") : "";
    const size = item.sizeCm ? ` · ${item.sizeCm.w} × ${item.sizeCm.h} cm` : "";
    box.append(el("p", "", `${item.quantity} × ${item.description}${item.method ? ` (${item.method})` : ""}${sizes}${size}`));
  }
  $("missing").replaceChildren(...(missing.length ? [el("p", "muted small", "Still needed: " + missing.join("; "))] : []));
}

function renderArtwork(artwork, reviews) {
  $("artwork").replaceChildren(...artwork.map((a) => {
    const review = reviews.find((r) => r.fileId === a.fileId);
    const state = review ? (review.printable ? "printable" : "needs a fix") : "not reviewed yet";
    return el("span", `chip ${review ? (review.printable ? "ok" : "warn") : ""}`, `${a.name}: ${state}`);
  }));
}

// The chat: a panel in the lower right (full screen on phones), with a launcher that counts unread agent replies.
const seenKey = `swagpay:seen:${token}`;
let agentReplies = 0;
let seenReplies = null;
try { const v = localStorage.getItem(seenKey); seenReplies = v === null ? null : Number(v); } catch {}
const chatIsOpen = () => !$("chat-panel").hidden;
const narrow = () => matchMedia("(max-width: 560px)").matches;

function markSeen() {
  seenReplies = agentReplies;
  try { localStorage.setItem(seenKey, String(seenReplies)); } catch {}
  renderBadge();
}

function renderBadge() {
  const unread = Math.max(0, agentReplies - (seenReplies ?? 0));
  $("chat-badge").hidden = unread === 0;
  $("chat-badge").textContent = String(unread);
  $("chat-open").setAttribute("aria-label", unread ? `Chat with the agent, ${unread} new ${unread === 1 ? "reply" : "replies"}` : "Chat with the agent");
}

function scrollChat() {
  const body = $("chat-body");
  body.scrollTop = body.scrollHeight;
}

function openChat() {
  $("chat-panel").hidden = false;
  $("chat-open").hidden = true;
  $("chat-open").setAttribute("aria-expanded", "true");
  document.body.classList.toggle("chat-lock", narrow());
  markSeen();
  scrollChat();
  $("text").focus();
}

function closeChat() {
  $("chat-panel").hidden = true;
  $("chat-open").hidden = false;
  $("chat-open").setAttribute("aria-expanded", "false");
  document.body.classList.remove("chat-lock");
  $("chat-open").focus();
}

function renderThread(thread) {
  if (thread.length === lastThreadLength) return;
  const first = lastThreadLength === -1;
  lastThreadLength = thread.length;
  const body = $("chat-body");
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  $("thread").replaceChildren(...thread.map((t) => el("div", `bubble ${t.from}`, t.text)));
  agentReplies = thread.filter((t) => t.from === "agent").length;
  if (chatIsOpen()) {
    markSeen();
    if (atBottom || first) scrollChat();
  } else {
    renderBadge();
  }
}

let openQuoteId = null;
let claimRequestId = null;

function renderQuote(quote) {
  $("quote-box").hidden = !quote;
  if (!quote) return;
  $("quote-label").textContent = `Quote #${quote.id}`;
  $("quote-price").textContent = quote.price;
  $("quote-currency").textContent = `${quote.currency} for the whole order`;
  $("quote-deposit").textContent = `${quote.deposit} ${quote.currency}`;
  $("quote-balance").textContent = `${money(Number(quote.price) - Number(quote.deposit))} ${quote.currency}`;
  const open = quote.status === "open";
  $("quote-valid-label").textContent = open ? "Valid until" : "Status";
  $("quote-valid").textContent = open
    ? `${warsaw(quote.validUntil)} (Warsaw time)`
    : quote.status === "accepted" ? "Accepted" : `No longer valid (${quote.status}); a new quote is coming`;
  openQuoteId = open ? quote.id : null;
  $("accept").hidden = !open;
  $("accept-note").hidden = !open;
}

const STAGE = { deposit: "Deposit", balance: "Balance" };

function renderPayments(payments, payTo) {
  $("pay-box").hidden = payments.length === 0;
  const open = payments.find((p) => p.status === "open");
  claimRequestId = open?.id ?? null;
  $("pay-due").hidden = !(open && payTo);
  $("pay-waiting").hidden = !(open && !payTo);
  if (open && payTo) {
    const partial = open.due !== open.amount;
    $("pay-stage").textContent = partial ? `${STAGE[open.stage]}: rest still due` : `${STAGE[open.stage]} due`;
    $("pay-amount").textContent = open.due;
    $("pay-unit").textContent = open.token;
    const share = Math.min(100, (Number(open.paid) / Number(open.amount)) * 100);
    $("pay-progress").style.width = `${share}%`;
    $("pay-progress-text").textContent = partial
      ? `Received ${money(open.paid)} of ${money(open.amount)} ${open.token} so far.`
      : "Nothing received yet for this payment.";
    $("pay-address").textContent = payTo.address;
    $("pay-token").textContent = `Token: ${payTo.tokens[open.token]}`;
    $("pay-token").hidden = false;
    $("pay-network").textContent = `Network: ${payTo.network} (chain ${payTo.chainId})`;
  }
  $("payments").replaceChildren(...payments.filter((p) => p.status === "paid").map((p) =>
    el("li", "", `✓ ${STAGE[p.stage]} received: ${p.amount} ${p.token}`)));
  if (!open && payments.length && payments.every((p) => p.status !== "open")) {
    $("payments").append(el("li", "muted", "All payments received. Thank you!"));
  }
}

async function refresh() {
  const res = await fetch(`/api/o/${token}`);
  if (res.status === 404) { $("event").textContent = "Order not found"; return; }
  const { order, view, quote, payments, payTo } = await res.json();
  $("job").textContent = `Order ${String(order.number).padStart(4, "0")}`;
  $("event").textContent = order.eventName;
  $("delivery").textContent = `Deliver to ${order.deliveryPlace} by ${warsaw(order.deliverBy)} (Warsaw time)`;
  renderStatus(order, quote, view.missing);
  const firstVisit = seenReplies === null;
  renderSpec(view.spec, view.missing);
  renderArtwork(view.artwork, view.spec.artwork);
  renderThread(view.thread);
  if (firstVisit && order.status === "draft" && !narrow() && !chatIsOpen()) openChat();
  renderQuote(quote);
  renderPayments(payments, payTo);
  $("received-box").hidden = order.status !== "balance_paid";
  $("busy").hidden = !view.busy;
  if (view.busy && chatIsOpen()) scrollChat();
}

$("chat-open").addEventListener("click", openChat);
$("status-chat").addEventListener("click", openChat);
$("chat-close").addEventListener("click", closeChat);
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && chatIsOpen()) closeChat(); });
$("text").addEventListener("keydown", (event) => {
  // Enter sends on a keyboard; on touch screens it adds a line.
  if (event.key === "Enter" && !event.shiftKey && !matchMedia("(pointer: coarse)").matches) {
    event.preventDefault();
    $("message-form").requestSubmit();
  }
});

for (const button of document.querySelectorAll("button.copy")) {
  button.addEventListener("click", async () => {
    const text = $(button.dataset.copyFrom).textContent;
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = label; }, 1500);
  });
}

$("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("chat-error").textContent = "";
  $("send").disabled = true;
  try {
    const res = await fetch(`/api/o/${token}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: $("text").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not send the message.");
    $("text").value = "";
    await refresh();
    scrollChat();
  } catch (err) {
    $("chat-error").textContent = err.message;
  } finally {
    $("send").disabled = false;
    $("text").focus();
  }
});

$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  if (!file) return;
  $("error").textContent = "";
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/o/${token}/artwork`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) $("error").textContent = data.error || "Could not upload the file.";
  $("file").value = "";
  await refresh();
});

$("accept").addEventListener("click", async () => {
  if (openQuoteId === null) return;
  $("error").textContent = "";
  $("accept").disabled = true;
  try {
    const res = await fetch(`/api/o/${token}/quote/accept`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: openQuoteId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not accept the quote.");
    await refresh();
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("accept").disabled = false;
  }
});

$("claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (claimRequestId === null) return;
  $("error").textContent = "";
  try {
    const res = await fetch(`/api/o/${token}/payments/${claimRequestId}/claim`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: $("tx").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not send the hash.");
    $("tx").value = "";
    $("error").textContent = "Thanks. We'll match it within a minute or two.";
  } catch (err) {
    $("error").textContent = err.message;
  }
});

$("received").addEventListener("click", async () => {
  if (!confirm("Confirm the swag arrived? This closes the order.")) return;
  $("error").textContent = "";
  $("received").disabled = true;
  try {
    const res = await fetch(`/api/o/${token}/received`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not confirm delivery.");
    await refresh();
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("received").disabled = false;
  }
});

refresh();
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 4000);
