const token = location.pathname.split("/").pop();
const $ = (id) => document.getElementById(id);
let lastThreadLength = -1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderSpec(spec, missing) {
  const box = $("spec");
  box.replaceChildren();
  if (!spec.items.length) box.textContent = "Nothing yet.";
  for (const item of spec.items) {
    const sizes = item.sizes ? " · " + Object.entries(item.sizes).map(([s, n]) => `${s} ${n}`).join(", ") : "";
    const size = item.sizeCm ? ` · ${item.sizeCm.w} × ${item.sizeCm.h} cm` : "";
    box.append(el("p", "", `${item.quantity} × ${item.description}${item.method ? ` (${item.method})` : ""}${sizes}${size}`));
  }
  $("missing").replaceChildren(...(missing.length ? [el("p", "muted", "Still needed: " + missing.join("; "))] : []));
}

function renderArtwork(artwork, reviews) {
  $("artwork").replaceChildren(...artwork.map((a) => {
    const review = reviews.find((r) => r.fileId === a.fileId);
    const state = review ? (review.printable ? "printable" : "needs a fix") : "not reviewed yet";
    return el("span", "chip", `${a.name}: ${state}`);
  }));
}

function renderThread(thread) {
  if (thread.length === lastThreadLength) return;
  lastThreadLength = thread.length;
  $("thread").replaceChildren(...thread.map((t) => el("div", `bubble ${t.from}`, t.text)));
}

let openQuoteId = null;
let claimRequestId = null;

function renderQuote(quote) {
  $("quote-box").hidden = !quote;
  if (!quote) return;
  $("quote-text").textContent = `Quote #${quote.id}: ${quote.price} ${quote.currency} for the whole order. Deposit: ${quote.deposit} ${quote.currency}.`;
  const until = new Date(quote.validUntil).toLocaleString("en-GB", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" });
  $("quote-valid").textContent = quote.status === "open" ? `Valid until ${until} (Warsaw time).` : quote.status === "accepted" ? "Quote accepted." : `This quote is ${quote.status}. The agent will send a new one.`;
  openQuoteId = quote.status === "open" ? quote.id : null;
  $("accept").hidden = openQuoteId === null;
}

function renderPayments(payments, payTo) {
  $("pay-box").hidden = payments.length === 0;
  $("payments").replaceChildren(...payments.map((p) => {
    const line = p.status === "paid"
      ? `${p.stage}: ${p.amount} ${p.token} — paid`
      : p.due !== p.amount
        ? `${p.stage}: send exactly ${p.due} ${p.token} (the rest of this payment)`
        : `${p.stage}: send exactly ${p.due} ${p.token}`;
    return el("p", p.status === "paid" ? "muted" : "", line);
  }));
  $("pay-address").textContent = payTo ? `${payTo.address} · ${payTo.network} (chain ${payTo.chainId})` : "Payment details will appear here soon.";
  const open = payments.find((p) => p.status === "open");
  $("pay-token").textContent = payTo && open ? `Token: ${payTo.tokens[open.token]}` : "";
  $("pay-token").hidden = !(payTo && open);
  claimRequestId = open?.id ?? null;
  $("claim-form").hidden = claimRequestId === null;
}

async function refresh() {
  const res = await fetch(`/api/o/${token}`);
  if (res.status === 404) { $("event").textContent = "Order not found"; return; }
  const { order, view, quote, payments, payTo } = await res.json();
  $("job").textContent = `Job ${String(order.number).padStart(4, "0")}`;
  $("event").textContent = order.eventName;
  const deliverBy = new Date(order.deliverBy).toLocaleString("en-GB", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" });
  $("delivery").textContent = `Deliver to ${order.deliveryPlace} by ${deliverBy} (Warsaw time)`;
  renderSpec(view.spec, view.missing);
  renderArtwork(view.artwork, view.spec.artwork);
  renderThread(view.thread);
  renderQuote(quote);
  renderPayments(payments, payTo);
  $("received-box").hidden = order.status !== "balance_paid";
  $("busy").hidden = !view.busy;
}

$("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").textContent = "";
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
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("send").disabled = false;
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
