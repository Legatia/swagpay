// Cloudflare Turnstile, rendered explicitly like public/new.js. Tokens are single-use: after one
// is used, nextToken() resets the widget and waits for the next.
let widgetId = null;
let token = null;
let used = false;
let enabled = false;
const waiters = [];

function loadScript() {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

// Resolves false when the server has no site key (local development without Turnstile).
export async function mountTurnstile(el) {
  const res = await fetch("/api/config");
  const { turnstileSiteKey } = res.ok ? await res.json() : {};
  if (!turnstileSiteKey) return false;
  await loadScript();
  widgetId = window.turnstile.render(el, {
    sitekey: turnstileSiteKey,
    callback: (t) => {
      token = t;
      used = false;
      while (waiters.length) waiters.shift()();
    },
    "expired-callback": () => {
      token = null;
    },
    // Wake anyone waiting: nextToken() then returns null, the server answers 403, and the retry
    // in sendOrder resets the widget.
    "error-callback": () => {
      token = null;
      while (waiters.length) waiters.shift()();
    },
  });
  enabled = true;
  return true;
}

export async function nextToken() {
  if (!enabled) return null;
  if (used) {
    token = null;
    used = false;
    window.turnstile.reset(widgetId);
  }
  if (!token) await new Promise((resolve) => waiters.push(resolve));
  used = true;
  return token;
}
