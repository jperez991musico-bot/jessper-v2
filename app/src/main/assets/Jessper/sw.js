// ================= StageLoop · sw.js =================
// Network first: con conexión siempre usa la versión nueva; sin conexión, la copia guardada.
// Los samples NO pasan por aquí: viven en IndexedDB.
const CACHE = 'stageloop-v13';
const ARCHIVOS = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg',
  'styles.css', 'panel.css', 'setlist.css', 'persist.css',
  'latencia.js', 'audioBridge.js', 'app.js', 'panel.js', 'setlist.js', 'persist.js', 'sfz.js', 'wav.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ARCHIVOS.map(u =>
        c.add(new Request(u, { cache: 'reload' }))
          .catch(err => console.warn('[SW] No se pudo guardar', u, err)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('stageloop-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const clave = url.origin + url.pathname;                 // sin ?v=…
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(clave, res.clone());
      return res;
    } catch (err) {
      const copia = await cache.match(clave) || await cache.match(req, { ignoreSearch: true });
      if (copia) return copia;
      if (req.mode === 'navigate') {
        const inicio = await cache.match(new URL('index.html', self.registration.scope).href);
        if (inicio) return inicio;
      }
      return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
