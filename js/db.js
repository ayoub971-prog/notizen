// IndexedDB: Hauptspeicher der App (bleibt auch offline erhalten).
// Stores:
//   folders { id, name, parentId, created }
//   notes   { id, folderId, html, title, text, created, modified, pinned, deleted }
//   files   { id, noteId, name, type, size, kind, blob, text, preview, created }
//   meta    { key, value }  (Einstellungen, Ordner-Zugriff, letzte Sicherung ...)
// Separat: Datenbank "notizen-inbox" fuer Inhalte aus dem Teilen-Menue
// (wird vom Service Worker befuellt, siehe sw.js).

const DB_NAME = 'notizen';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('folderId', 'folderId');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }).createIndex('noteId', 'noteId');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Datenbank blockiert – bitte andere Notizen-Tabs schliessen.'));
    });
  }
  return dbPromise;
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Abgebrochen')); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getAll(store) { const db = await openDb(); return req(db.transaction(store).objectStore(store).getAll()); }
export async function get(store, key) { const db = await openDb(); return req(db.transaction(store).objectStore(store).get(key)); }
export async function put(store, value) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); await done(tx); return value; }
export async function putMany(store, values) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); const s = tx.objectStore(store); for (const v of values) s.put(v); await done(tx); }
export async function del(store, key) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); await done(tx); }
export async function delMany(store, keys) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); const s = tx.objectStore(store); for (const k of keys) s.delete(k); await done(tx); }
export async function getMeta(key, fallback = null) { const r = await get('meta', key); return r ? r.value : fallback; }
export async function setMeta(key, value) { return put('meta', { key, value }); }

export function newId(prefix = '') {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Date.now().toString(36) + '-' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

// ---- Eingang fuer geteilte Inhalte (gleiches Schema wie in sw.js!) ----
function openInbox() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('notizen-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/** Holt alle wartenden geteilten Inhalte und loescht sie aus dem Eingang. */
export async function takeInbox() {
  const db = await openInbox();
  const tx = db.transaction('items', 'readwrite');
  const items = await req(tx.objectStore('items').getAll());
  tx.objectStore('items').clear();
  await done(tx);
  db.close();
  return items;
}
