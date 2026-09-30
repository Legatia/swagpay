const form = document.getElementById("order-form");
const error = document.getElementById("error");
const submit = document.getElementById("submit");
let turnstileToken = null;
let widgetId = null;
// One key per form: a retry after a lost response returns the order already created instead of a second one.
const idempotencyKey = crypto.randomUUID();

async function setUpTurnstile() {
  try {
    const { turnstileSiteKey } = await (await fetch("/api/config")).json();
    if (!turnstileSiteKey) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
    widgetId = window.turnstile.render("#turnstile", {
      sitekey: turnstileSiteKey,
      // The normal widget is 300 px wide and overflows the narrowest phones.
      size: matchMedia("(max-width: 365px)").matches ? "compact" : "normal",
      callback: (token) => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = null; },
    });
  } catch {
    error.textContent = "The human check could not load. Refresh the page and try again.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  submit.disabled = true;
  const body = Object.fromEntries(new FormData(form).entries());
  body.turnstile = turnstileToken;
  body.idempotencyKey = idempotencyKey;
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create the order.");
    location.href = data.url;
  } catch (err) {
    error.textContent = err.message;
    submit.disabled = false;
    if (widgetId !== null && window.turnstile) { window.turnstile.reset(widgetId); turnstileToken = null; }
  }
});

setUpTurnstile();
