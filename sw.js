const CACHE_NAME = 'redline-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './puzzles.json'
];

// 1. Pre-cache core app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// 2. Clean up old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// 3. Network-first for app & puzzles, cache-first for fonts/CDN
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache analytics or Supabase auth/database requests
  if (
    url.hostname.includes('umami.is') ||
    url.hostname.includes('plausible.io') ||
    url.hostname.includes('supabase.co')
  ) {
    return;
  }

  // Same-origin (index.html, puzzles.json): Network-first so updates show immediately,
  // falling back to cache if campus Wi-Fi drops.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // External assets (Tailwind CDN, Google Fonts, Supabase SDK): Cache-first so styling works offline
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});