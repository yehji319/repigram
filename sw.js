// 오프라인에서도 앱 화면이 열리도록 앱 파일을 캐시합니다 (네트워크 우선).
const CACHE = "repigram-v6";
const ASSETS = ["./", "index.html", "styles.css", "app.js", "db.js", "ai.js", "supabase.js", "config.js", "scale.js", "cooking.js", "partners.js", "icon-192.png", "icon-512.png", "manifest.webmanifest", "logo.png", "wordmark.png", "wordmark.js", "wm-base.png", "wm-carrot.png", "wm-egg.png", "wm-stick.png", "terms.html", "privacy.html", "copyright.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
