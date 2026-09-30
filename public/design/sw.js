import { CACHE, PRECACHE, route } from "/design/js/sw-routes.js";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("swagpay-design-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale while revalidate: answer from the cache when there is a copy, refresh it in the background,
// so an update arrives on the next visit and the editor opens offline.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const kind = route(new URL(req.url), self.location.origin);
  if (kind === "network") return;
  // Started here, not inside respondWith, so waitUntil can keep the worker alive until the cache is
  // updated. Otherwise the browser may stop it mid-refresh and leave modules from two deploys side by side.
  const network = fetch(req)
    .then((res) => {
      // Clone now: once the page starts reading res, it can't be cloned.
      const copy = res.ok || res.type === "opaque" ? res.clone() : null;
      return { res, put: copy ? caches.open(CACHE).then((c) => c.put(req, copy)) : null };
    })
    .catch(() => ({ res: null, put: null }));
  event.waitUntil(network.then(({ put }) => put).catch(() => {}));
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: kind === "static" });
      if (cached) return cached;
      const { res } = await network;
      if (res) return res;
      if (req.mode === "navigate") return (await cache.match("/design/")) ?? Response.error();
      return Response.error();
    }),
  );
});
