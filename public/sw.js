// Bump this version on cache-strategy changes to purge old caches.
const CACHE_NAME = "nutrichat-v2";

self.addEventListener("install", () => {
  // Activate the new SW immediately, don't wait for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests. Let API POSTs and cross-origin pass through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigation (HTML) → network-first so index.html is always fresh.
  // This prevents stale HTML pointing at deleted asset hashes (black-page bug).
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Hashed static assets (/assets/*) are immutable → cache-first.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
    return;
  }

  // Everything else → network, fall back to cache when offline.
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow("/"));
});
