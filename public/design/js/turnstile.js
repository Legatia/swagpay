import { SendError } from "./submit.js";

// Cloudflare Turnstile, rendered explicitly like public/new.js. Tokens are single-use: after one
// is used, nextToken() resets the widget and waits for the next.
let widgetId = null;
let token = null;
let used = false;
let enabled = false;
let ready = null; // the newest mount attempt
const waiters = [];

function loadScript() {
  // window.turnstile is also the <div id="turnstile"> until the real API replaces it.
  if (typeof window.turnstile?.render === "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

// Resolves false when the server has no site key (local development without Turnstile).
async function mount(el) {
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

export function mountTurnstile(el) {
  ready = mount(el);
  return ready;
}

const NO_CHECK = "The human check couldn't load. Check your connection, then refresh the page and send again.";

export async function nextToken() {
  let mountedOk = false;
  try {
    mountedOk = ready ? await ready : false;
  } catch {
    throw new SendError(NO_CHECK);
  }
  if (!ready) throw new SendError(NO_CHECK);
  if (!mountedOk || !enabled) return null; // the server has Turnstile off
  if (used) {
    token = null;
    used = false;
    window.turnstile.reset(widgetId);
  }
  if (!token) await new Promise((resolve) => waiters.push(resolve));
  used = true;
  return token;
}
