// Service Worker: macht die App offline nutzbar und nimmt Inhalte aus dem
// Android-Teilen-Menue entgegen (Web Share Target, siehe manifest.webmanifest).
// Bei jeder neuen Version: VERSION erhoehen UND ?v=... in index.html/ASSETS anpassen.
const VERSION = '3';
const CACHE = 'notizen-v' + VERSION;
const ASSETS = [
  './', './index.html', './styles.css?v=3', './manifest.webmanifest?v=3',
  './icons/icon.svg?v=3', './icons/icon-192.png?v=3', './icons/icon-512.png?v=3', './icons/icon-maskable-512.png',
  './js/app.js?v=3', './js/db.js', './js/ui.js', './js/tree.js', './js/search.js', './js/blocks.js', './js/htmlparse.js',
  './js/sanitize.js', './js/editor.js', './js/importer.js', './js/sharetarget.js', './js/media.js', './js/backup.js',
  './js/share.js', './js/pdf.js', './js/pdf-metrics.js', './js/zip.js', './js/exportfmt.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('notizen-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// ---- Eingang fuer geteilte Inhalte (gleiches Schema wie takeInbox() in js/db.js) ----
function openInbox() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('notizen-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function handleShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    const files = [];
    for (const f of form.getAll('files')) if (f && typeof f === 'object' && f.size > 0) files.push({ name: f.name, type: f.type, blob: f });
    const item = { created: Date.now(), title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''), files };
    const db = await openInbox();
    await new Promise((res, rej) => { const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').add(item); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    return Response.redirect(scope + '?share=1', 303);
  } catch (e) {
    return Response.redirect(scope + '?share=error', 303);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(handleShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Seite immer aus dem Cache (offline), Parameter wie ?share=1 ignorieren
    e.respondWith(caches.match('./index.html', { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
    if (res.ok && url.pathname.includes('/icons/')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
