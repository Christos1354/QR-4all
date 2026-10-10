// Κωδικοί QR — service worker (λειτουργία χωρίς ίντερνετ / offline)
const C = "qr-2026-10-10";
const CORE = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    // Πάντα η νεότερη έκδοση όταν υπάρχει ίντερνετ / always newest when online
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(C).then((c) => c.put("./", cp)); }
      return r;
    }).catch(() => caches.match("./")));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
