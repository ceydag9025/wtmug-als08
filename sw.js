/* ALŞ08 — Service Worker (app shell önbelleği) */
const VERSION = 'als08-v1';

const CORE = [
  './', './index.html', './mobile.html',
  './app.js', './style.css',
  './manifest.json', './icon.svg', './icon-maskable.svg',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(
      CORE.map(url => cache.add(url).catch(err => console.warn('[SW] atlandı:', url, err)))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: false });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      // Çevrimdışı: gezinme isteği ise ilgili sayfayı ver
      if (req.mode === 'navigate') {
        const alt = await caches.match(req.url.includes('mobile') ? './mobile.html' : './index.html');
        if (alt) return alt;
      }
      return new Response('Çevrimdışısınız.', { status: 503, statusText: 'Offline' });
    }
  })());
});