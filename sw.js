// Lets Haven open without internet. Bump VERSION when you change files so phones pick up the update.
const VERSION = "haven-v2";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "firebase-config.js", "firebase-sync.js", "push-config.js",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache Firebase traffic (sign-in and database calls)
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseapp.com")) return;

  // Own files: try the network first so updates show up, fall back to the saved copy offline
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  // Fonts and the Firebase library: use the saved copy, fetch once if missing
  if (url.hostname === "www.gstatic.com" || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
});

// Reminders sent by the Cloudflare notifier
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Haven", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./" }
  }));
});

// Tapping a notification opens Haven (or brings it to the front)
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.location.href).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus(); }
    return clients.openWindow(target);
  })());
});
