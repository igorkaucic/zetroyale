// ZET Royale Service Worker â€” Auto-Update Engine
// VERSION: 0.0.8
const CACHE_VERSION = 'zr-v0.0.8';
const STATIC_CACHE = CACHE_VERSION + '-static';

// Assets to pre-cache on install
const PRECACHE_URLS = [
  './',
  './index.html',
  './icon.png'
];

// Install â€” pre-cache shell, skip waiting immediately
self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate â€” purge old caches, claim all clients
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE)
          .map(key => {
            console.log('[SW] Purging old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch â€” Network-first for HTML/navigation, Cache-first for hashed assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET') return;
  
  // Skip API calls, WebSocket upgrades, and external requests
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation requests (HTML) â€” always network-first
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Hashed assets (Vite adds hashes like index-BmovTxRk.js) â€” cache-first
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else â€” network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then(response => {
        const clone = response.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
