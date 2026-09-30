import { SendError } from "./submit.js";

// Cloudflare Turnstile, rendered explicitly like public/new.js. Tokens are single-use: after one
// is used, nextToken() resets the widget and waits for the next.
let widgetId = null;
let token = null;
let used = false;
let enabled = false;
let ready = null; // the newest mount attempt
const waiters = [];

const CONFIG_TIMEOUT_MS = 10_000;
const SCRIPT_TIMEOUT_MS = 20_000;

function loadScript() {
  // window.turnstile is also the <div id="turnstile"> until the real API replaces it.
  if (typeof window.turnstile?.render === "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const fail = (err) => {
      clearTimeout(timer);
      s.remove(); // a later attempt adds a fresh tag
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("script timeout")), SCRIPT_TIMEOUT_MS);
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => fail(new Error("script"));
    document.head.append(s);
  });
}

// Resolves false only when the server answers with no site key; the backend then accepts orders
// only if REQUIRE_TURNSTILE is 0. Any other failure rejects, so the mount is tried again.
async function mount(el) {
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(CONFIG_TIMEOUT_MS) : undefined;
  const res = await fetch("/api/config", signal ? { signal } : undefined);
  if (!res.ok) throw new Error("config");
  const { turnstileSiteKey } = await res.json();
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

export const NO_CHECK = "The human check couldn't load. Check your connection; it tries again when you're back online, then send again.";

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
