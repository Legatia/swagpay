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
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: kind === "static" });
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) return cached;
      const res = await network;
      if (res) return res;
      if (req.mode === "navigate") return (await cache.match("/design/")) ?? Response.error();
      return Response.error();
    }),
  );
});
