// What the editor's service worker caches. Kept apart from sw.js so it can be unit-tested.
// Bump CACHE when PRECACHE changes, and on any deploy that changes a module's exports or the page
// markup, so the editor updates as one unit. When adding a file to public/design/js, add it here too.
export const CACHE = "swagpay-design-v2";

const SHARED = new Set(["/brand-tokens.css", "/logo.svg", "/logo-on-dark.svg", "/mascot.svg", "/mark.svg", "/favicon.ico", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png"]);
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

export function route(url, origin) {
  if (url.origin !== origin) return FONT_HOSTS.has(url.hostname) ? "font" : "network";
  if (url.pathname.startsWith("/design/") || SHARED.has(url.pathname)) return "static";
  return "network";
}

const JS = [
  "app.js", "controls.js", "details.js", "export.js", "files.js", "geometry.js", "gestures.js",
  "layers.js", "mockups.js", "panel.js", "pricing.js", "products.js", "pwa.js", "quality.js",
  "raster.js", "review.js", "spec.js", "stage.js", "sticker.js", "store.js", "submit.js",
  "sw-routes.js", "turnstile.js", "upload.js",
];

export const PRECACHE = [
  "/design/",
  "/design/design.css",
  "/design/price-table.json",
  "/design/manifest.webmanifest",
  "/design/icons/icon-192.png",
  "/design/icons/icon-512.png",
  ...JS.map((f) => `/design/js/${f}`),
  ...SHARED,
];
