// Datensicherung ausserhalb des Browsers.
//
// 1) Automatische Ordner-Sicherung (File System Access API, showDirectoryPicker):
//    Der Benutzer waehlt EINMAL einen Ordner (z. B. Dokumente/Notizen). Danach
//    schreibt die App bei jeder Aenderung jede Notiz als lesbare .html + .txt
//    Datei plus Anhaenge in eine Ordnerstruktur, die den App-Ordnern entspricht.
//    Chrome fuer Android unterstuetzt das seit Version 132. Der Zugriff kann vom
//    Browser wieder entzogen werden (z. B. nach Neustart) -> dann zeigt die App
//    einen Hinweis "Zugriff erneut erlauben" (ein Tippen genuegt).
// 2) ZIP-Sicherung: alles als eine ZIP-Datei in "Downloads" (oder Teilen nach
//    Google Drive). Enthaelt dieselben lesbaren Dateien plus
//    _wiederherstellung/backup.json zum Wiederherstellen.
import * as db from './db.js';
import { pathOf } from './tree.js';
import { htmlToBlocks, blocksToText } from './blocks.js';
import { assignFileNames, assignAttachmentNames, linkAttachments, standaloneHtml } from './exportfmt.js';
import { zipParts, readZip } from './zip.js';

export const TRASH_DIR = 'Zuletzt gelöscht';
export const folderSyncSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const README = `NOTIZEN – Sicherung
====================

Dieser Ordner wird von der App «Notizen» automatisch geschrieben.
Jede Notiz liegt als .html (mit Bildern und Tabellen, im Browser öffnen)
und als .txt (reiner Text) vor. Anhänge (PDF, Sprachmemos, Dateien)
liegen im Ordner «<Notiz> – Anhänge».

Die Dateien bleiben erhalten, auch wenn die App gelöscht wird.
Zum Wiederherstellen in der App: Sicherung > «Aus ZIP wiederherstellen»
(dafür eine ZIP-Sicherung verwenden).
`;

/** Liefert fuer alle Notizen: Zielordner (Segmente), Dateiname, Anhangsnamen. */
export function planLayout(folders, notes, files) {
  const groups = new Map();
  for (const n of notes) {
    const segs = n.deleted ? [TRASH_DIR] : pathOf(folders, n.folderId);
    const key = segs.join('/');
    if (!groups.has(key)) groups.set(key, { segs, notes: [] });
    groups.get(key).notes.push(n);
  }
  const plan = new Map();
  for (const g of groups.values()) {
    const names = assignFileNames(g.notes);
    for (const n of g.notes) {
      const nf = files.filter((f) => f.noteId === n.id);
      plan.set(n.id, { segs: g.segs.length ? g.segs : ['Notizen'], base: names.get(n.id), attNames: assignAttachmentNames(nf), files: nf });
    }
  }
  return plan;
}

/** Erzeugt die lesbaren Dateien einer Notiz: [{ segs, name, data(Blob|string) }] */
export function noteOutputs(note, p, folders) {
  const attDir = `${p.base} – Anhänge`;
  const links = new Map(p.files.map((f) => [f.id, { href: encodeURI(`${attDir}/${p.attNames.get(f.id)}`), name: p.attNames.get(f.id), kind: f.kind }]));
  const body = linkAttachments(note.html || '', links);
  const blocks = htmlToBlocks(note.html || '');
  const text = blocksToText(blocks, (id) => `[Anhang: ${p.attNames.get(id) || '?'}]`);
  const out = [
    { segs: p.segs, name: `${p.base}.html`, data: standaloneHtml({ title: note.title, bodyHtml: body, folderPath: note.deleted ? TRASH_DIR : pathOf(folders, note.folderId).join(' / '), modified: note.modified }) },
    { segs: p.segs, name: `${p.base}.txt`, data: text },
  ];
  for (const f of p.files) if (f.blob) out.push({ segs: [...p.segs, attDir], name: p.attNames.get(f.id), data: f.blob });
  return out;
}

// ---------------- Ordner-Sicherung ----------------
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

export async function getDirHandle() { return db.getMeta('dirHandle'); }

export async function permission(handle, ask = false) {
  if (!handle) return 'none';
  if (typeof handle.queryPermission !== 'function') return 'granted'; // aeltere Umsetzung: Schreibfehler zeigen Probleme
  try {
    let s = await handle.queryPermission({ mode: 'readwrite' });
    if (s !== 'granted' && ask) s = await handle.requestPermission({ mode: 'readwrite' });
    return s;
  } catch { return 'denied'; }
}

/** Muss direkt aus einem Klick aufgerufen werden. */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'notizen-sicherung', mode: 'readwrite', startIn: 'documents' });
  await db.setMeta('dirHandle', handle);
  await db.setMeta('syncState', {});
  return handle;
}

export async function stopFolderSync() { await db.setMeta('dirHandle', null); await db.setMeta('syncState', {}); }

async function dirFor(root, segs, create = true) {
  let d = root;
  for (const s of segs) d = await d.getDirectoryHandle(s, { create });
  return d;
}
async function writeFile(root, segs, name, data) {
  const d = await dirFor(root, segs);
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
async function removePath(root, path) {
  const segs = path.split('/');
  const name = segs.pop();
  try {
    const d = await dirFor(root, segs, false);
    await d.removeEntry(name);
    // leere Ordner aufraeumen (nur wenn wirklich leer)
    for (let k = segs.length; k > 0; k--) {
      const parent = await dirFor(root, segs.slice(0, k - 1), false);
      const child = await dirFor(root, segs.slice(0, k), false);
      let empty = true;
      for await (const _ of child.keys()) { empty = false; break; }
      if (!empty) break;
      await parent.removeEntry(segs[k - 1]);
    }
  } catch { /* existiert nicht mehr - ok */ }
}

/**
 * Gleicht den Sicherungsordner mit der Datenbank ab. Nur geaenderte Notizen
 * werden neu geschrieben (Signatur = Aenderungszeit + Pfade).
 * onlyIds: optional nur bestimmte Notizen pruefen (schnell beim Tippen).
 * Rueckgabe: { status: 'ok'|'none'|'prompt'|'error', written, error }
 */
export function syncFolder({ onlyIds = null } = {}) {
  return serial(async () => {
    const root = await getDirHandle();
    if (!root) return { status: 'none' };
    const perm = await permission(root);
    if (perm !== 'granted') return { status: 'prompt' };
    try {
      const [folders, notes, files] = await Promise.all([db.getAll('folders'), db.getAll('notes'), db.getAll('files')]);
      const state = (await db.getMeta('syncState')) || {};
      if (!state.__readme) { await writeFile(root, [], 'LIESMICH.txt', README); state.__readme = { sig: 1, paths: [] }; }
      const plan = planLayout(folders, notes, files);
      let written = 0;
      for (const n of notes) {
        if (onlyIds && !onlyIds.includes(n.id) && state[n.id]) continue;
        const p = plan.get(n.id);
        const outs = noteOutputs(n, p, folders);
        const paths = outs.map((o) => [...o.segs, o.name].join('/'));
        const sig = `${n.modified}|${p.files.map((f) => f.id).join(',')}|${paths.join('|')}`;
        const old = state[n.id];
        if (old && old.sig === sig) continue;
        for (const o of outs) await writeFile(root, o.segs, o.name, o.data);
        if (old) for (const pth of old.paths) if (!paths.includes(pth)) await removePath(root, pth);
        state[n.id] = { sig, paths };
        written++;
        await db.setMeta('syncState', state);
      }
      if (!onlyIds) { // endgueltig geloeschte Notizen entfernen
        const ids = new Set(notes.map((n) => n.id));
        for (const [id, st] of Object.entries(state)) {
          if (id.startsWith('__') || ids.has(id)) continue;
          for (const pth of st.paths) await removePath(root, pth);
          delete state[id];
        }
      }
      await db.setMeta('syncState', state);
      await db.setMeta('lastFolderSync', Date.now());
      return { status: 'ok', written };
    } catch (e) {
      console.error(e);
      if (e && e.name === 'NotAllowedError') return { status: 'prompt' };
      return { status: 'error', error: e.message || String(e) };
    }
  });
}

// ---------------- ZIP-Sicherung ----------------
export async function buildBackupZip() {
  const [folders, notes, files] = await Promise.all([db.getAll('folders'), db.getAll('notes'), db.getAll('files')]);
  const plan = planLayout(folders, notes, files);
  const entries = [{ name: 'LIESMICH.txt', data: README }];
  const fileMeta = [];
  for (const n of notes) {
    const p = plan.get(n.id);
    for (const o of noteOutputs(n, p, folders)) {
      const name = ['Notizen', ...o.segs, o.name].join('/');
      const data = typeof o.data === 'string' ? o.data : new Uint8Array(await o.data.arrayBuffer());
      entries.push({ name, data, date: new Date(n.modified || Date.now()) });
      const f = p.files.find((x) => p.attNames.get(x.id) === o.name && o.segs.length > p.segs.length);
      if (f) fileMeta.push({ ...f, blob: undefined, zipPath: name });
    }
  }
  const backup = { app: 'Notizen', format: 1, exported: new Date().toISOString(), folders, notes, files: fileMeta };
  entries.push({ name: '_wiederherstellung/backup.json', data: JSON.stringify(backup) });
  return new Blob(zipParts(entries), { type: 'application/zip' });
}

export function backupFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Notizen-Sicherung-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.zip`;
}

/** Liest eine ZIP-Sicherung. Rueckgabe: { folders, notes, files (mit blob) } */
export async function readBackupZip(file) {
  const entries = readZip(new Uint8Array(await file.arrayBuffer()));
  const json = entries.find((e) => e.name === '_wiederherstellung/backup.json');
  if (!json || !json.data) throw new Error('Diese ZIP-Datei ist keine Notizen-Sicherung.');
  const backup = JSON.parse(new TextDecoder().decode(json.data));
  if (backup.app !== 'Notizen') throw new Error('Unbekanntes Sicherungsformat.');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const files = [];
  for (const f of backup.files || []) {
    const e = byName.get(f.zipPath);
    if (e && e.data) { const { zipPath, ...rest } = f; files.push({ ...rest, blob: new Blob([e.data], { type: f.type || 'application/octet-stream' }) }); }
  }
  return { folders: backup.folders || [], notes: backup.notes || [], files };
}
