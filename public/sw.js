/*
 * Marine Video Portal service worker.
 *
 * Deliberately minimal and conservative. Its ONLY job is to make the app
 * installable and to serve the static app icons offline. It must never cache
 * anything user-specific or security-sensitive, because of how this app works:
 *   - Video playback uses short-lived signed bunny.net embed tokens.
 *   - Thumbnail URLs are signed and time-limited.
 *   - Every /api/* response is per-viewer data behind an Auth0 session.
 *   - /auth/* is the Auth0 login/callback flow.
 * So the fetch handler below only ever answers for a fixed allowlist of
 * immutable, public static assets. Everything else falls through to the
 * network untouched (the SW does not call respondWith for it).
 */
const CACHE = "mvp-static-v1";

// Immutable, non-secret, public assets safe to cache.
const PRECACHE = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Web Push: show the notification, and focus/open the app on click. The
// payload is a small JSON blob sent by lib/push.js ({ title, body, url }).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Marine Video Portal";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab if one is open, otherwise open a new one.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only ever handle our own precached static assets. Never touch cross-origin
  // (bunny.net embeds/thumbnails), /api/*, /auth/*, or page navigations.
  if (url.origin !== self.location.origin) return;
  if (!PRECACHE.includes(url.pathname)) return;

  // Cache-first for the static allowlist; refresh the cache in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
