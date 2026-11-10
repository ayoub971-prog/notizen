// Notizen – Hauptprogramm: Ansichten (Ordner -> Notizen -> Editor), Speichern,
// Suche, Anhaenge, Teilen, Sicherung. Alle Daten bleiben auf dem Geraet.
//
// Aufbau der Module:
//   db.js        IndexedDB (Hauptspeicher)       editor.js   Editor-Befehle
//   tree.js      Ordnerlogik                     importer.js Abfrage Original/PDF
//   search.js    Volltextsuche                   share.js    Teilen/Drucken
//   blocks.js    HTML -> Bloecke (PDF/Text)      backup.js   Ordner-Sicherung + ZIP
//   pdf.js       eigener PDF-Generator           zip.js      eigener ZIP-Schreiber
//   sanitize.js  HTML-Bereinigung                media.js    Bilder, Sprachaufnahme
import * as db from './db.js';
import { $, el, toast, dialog, confirmDialog, promptDialog, infoDialog, formatDate, formatSize } from './ui.js';
import { flattenTree, pathOf, descendantIds, canMoveFolder, planDeleteFolder, validateFolderName } from './tree.js';
import { buildIndex, search, snippet } from './search.js';
import { htmlToBlocks, blocksToText, runsText } from './blocks.js';
import { sanitizeHtml } from './sanitize.js';
import * as ed from './editor.js';
import { importItems } from './importer.js';
import { parseShared } from './sharetarget.js';
import { imageToJpeg, startRecording, recordingSupported, audioExt } from './media.js';
import * as backup from './backup.js';
import { shareFiles, shareText, notePdf, noteText, printNote, download } from './share.js';
import { escapeText, escapeAttr } from './htmlparse.js';

export const APP_VERSION = '1';
const DEFAULT_FOLDER = 'f-default';
const TRASH_DAYS = 30;
const REMIND_DAYS = 7;
const COLORS = [['Rot', '#d93025'], ['Orange', '#e8710a'], ['Gold', '#b8860b'], ['Grün', '#188038'], ['Blau', '#1a73e8'], ['Violett', '#8430ce'], ['Grau', '#80868b']];

const app = $('#app');
const editor = $('#editor');
const S = {
  folders: [], notes: [], files: new Map(),
  folderId: 'all', noteId: null, collapsed: new Set(),
  index: null, saveTimer: null, syncTimer: null, syncIds: new Set(),
  urls: [], depth: 0, lastCopy: '', installPrompt: null, syncProblem: null,
};

const ICON = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  all: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>',
};
const svg = (name) => { const t = document.createElement('template'); t.innerHTML = ICON[name]; return t.content.firstChild; };

// ================= Daten =================
const realFolder = (id) => (S.folders.some((f) => f.id === id) ? id : DEFAULT_FOLDER);
const folderPathStr = (id) => pathOf(S.folders, id).join(' / ');
const noteById = (id) => S.notes.find((n) => n.id === id);
const attName = (id) => S.files.get(id)?.name || 'Anhang';

function notesIn(folderId) {
  let list;
  if (folderId === 'trash') list = S.notes.filter((n) => n.deleted);
  else if (folderId === 'all') list = S.notes.filter((n) => !n.deleted);
  else list = S.notes.filter((n) => !n.deleted && n.folderId === folderId);
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.modified - a.modified);
}

async function loadAll() {
  const [folders, notes, files] = await Promise.all([db.getAll('folders'), db.getAll('notes'), db.getAll('files')]);
  S.folders = folders; S.notes = notes; S.files = new Map(files.map((f) => [f.id, f]));
  if (!S.folders.some((f) => f.id === DEFAULT_FOLDER)) {
    const f = { id: DEFAULT_FOLDER, name: 'Notizen', parentId: null, created: Date.now() };
    await db.put('folders', f); S.folders.push(f);
  }
  S.index = null;
}

/** Aufraeumen beim Start: Papierkorb nach 30 Tagen leeren, verwaiste Anhaenge entfernen. */
async function housekeeping() {
  const old = S.notes.filter((n) => n.deleted && Date.now() - n.deleted > TRASH_DAYS * 864e5);
  for (const n of old) await deleteForever(n.id, false);
  const referenced = new Set();
  for (const n of S.notes) for (const m of String(n.html || '').matchAll(/data-att="([^"]+)"/g)) referenced.add(m[1]);
  const orphans = [...S.files.values()].filter((f) => !referenced.has(f.id) && Date.now() - f.created > 864e5);
  if (orphans.length) { await db.delMany('files', orphans.map((f) => f.id)); orphans.forEach((f) => S.files.delete(f.id)); }
}

// ================= Navigation =================
function setView(view) {
  if (app.dataset.view === view) return;
  app.dataset.view = view;
  history.pushState({ view }, '');
  S.depth++;
}
function goBack(fallback) {
  if (S.depth > 0) history.back();
  else { if (app.dataset.view === 'editor') closeEditor(); app.dataset.view = fallback; render(); }
}
window.addEventListener('popstate', (e) => {
  S.depth = Math.max(0, S.depth - 1);
  const v = e.state?.view || 'folders';
  if (app.dataset.view === 'editor' && v !== 'editor') closeEditor();
  app.dataset.view = v;
  render();
});

function render() { renderFolders(); renderNotes(); }

// ================= Ordnerliste =================
function folderRow({ id, name, count, icon, depth = 0, hasChildren = false, actions = false }) {
  const li = el('li', { class: 'folder-row' + (S.folderId === id ? ' active' : '') });
  li.style.paddingLeft = `${4 + depth * 18}px`;
  if (hasChildren) {
    li.append(el('button', { class: 'twisty' + (S.collapsed.has(id) ? ' closed' : ''), type: 'button', 'aria-label': S.collapsed.has(id) ? 'Unterordner zeigen' : 'Unterordner verbergen',
      onclick: () => { S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id); localStorage.setItem('collapsed', JSON.stringify([...S.collapsed])); renderFolders(); } }, svg('chevron')));
  } else li.append(el('span', { class: 'twisty' }));
  const open = el('button', { class: 'open', type: 'button', onclick: () => openFolder(id) }, svg(icon), el('span', { class: 'name' }, name), el('span', { class: 'count' }, String(count)));
  li.append(open);
  if (actions) li.append(el('button', { class: 'more', type: 'button', 'aria-label': `Aktionen für Ordner ${name}`, onclick: () => folderActions(id) }, svg('more')));
  return li;
}

function renderFolders() {
  const ul = $('#folder-list');
  ul.replaceChildren();
  ul.append(folderRow({ id: 'all', name: 'Alle Notizen', count: notesIn('all').length, icon: 'all' }));
  for (const { folder, depth, hasChildren } of flattenTree(S.folders, S.collapsed)) {
    ul.append(folderRow({ id: folder.id, name: folder.name, count: notesIn(folder.id).length, icon: 'folder', depth, hasChildren, actions: true }));
  }
  const trash = notesIn('trash').length;
  ul.append(folderRow({ id: 'trash', name: 'Zuletzt gelöscht', count: trash, icon: 'trash' }));
}

function openFolder(id) {
  S.folderId = id;
  localStorage.setItem('folder', id);
  if (id !== 'all' && id !== 'trash') localStorage.setItem('lastRealFolder', id);
  renderNotes(); renderFolders();
  setView('notes');
}

// ================= Notizliste =================
function previewOf(n) {
  const lines = String(n.text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[=-]+$/.test(l));
  return lines[1] || (n.html && /<img/.test(n.html) ? 'Bild' : 'Kein weiterer Text');
}

function renderNotes() {
  const id = S.folderId;
  const title = id === 'all' ? 'Alle Notizen' : id === 'trash' ? 'Zuletzt gelöscht' : (S.folders.find((f) => f.id === id)?.name || 'Notizen');
  $('#notes-title').textContent = title;
  $('#back-notes-label').textContent = title;
  const list = notesIn(id);
  const ul = $('#note-list');
  ul.replaceChildren();
  for (const n of list) {
    const b = el('button', { class: 'note-row' + (n.id === S.noteId ? ' active' : ''), type: 'button', onclick: () => openNote(n.id) },
      el('div', { class: 't' }, n.pinned ? el('span', { class: 'pin', 'aria-label': 'Angeheftet' }, '● ') : null, n.title || 'Neue Notiz'),
      el('div', { class: 'p' }, el('b', {}, formatDate(n.modified)), id === 'all' ? `${folderPathStr(n.folderId)} · ` : '', previewOf(n)));
    ul.append(el('li', {}, b));
  }
  $('#notes-empty').hidden = list.length > 0;
  $('#notes-count').textContent = list.length === 1 ? '1 Notiz' : `${list.length} Notizen`;
  $('#btn-empty-trash').hidden = !(id === 'trash' && list.length);
  $('#btn-new-note').hidden = id === 'trash';
}

// ================= Suche =================
function ensureIndex() {
  if (!S.index) S.index = buildIndex({ folders: S.folders, notes: S.notes, files: [...S.files.values()], folderPath: folderPathStr });
  return S.index;
}
function markText(container, text, q) {
  const s = snippet(text, q, 36);
  if (typeof s === 'string') { container.append(s); return; }
  container.append(s.before, el('mark', {}, s.match), s.after);
}
function renderResults(listEl, otherEl, q) {
  const query = q.trim();
  listEl.hidden = !query; otherEl.hidden = !!query;
  if (!query) return;
  const res = search(ensureIndex(), query, 80);
  listEl.replaceChildren();
  if (!res.length) { listEl.append(el('li', { class: 'note-row' }, el('div', { class: 'p' }, 'Keine Treffer'))); return; }
  for (const r of res) {
    const kind = r.kind === 'folder' ? 'Ordner' : r.kind === 'file' ? 'Anhang' : 'Notiz';
    const p = el('div', { class: 'p' });
    if (r.kind === 'file') p.append(`in «${noteById(r.noteId)?.title || 'Notiz'}» · `);
    else if (r.sub) p.append(r.sub + ' · ');
    if (r.text) markText(p, r.text, query);
    const t = el('div', { class: 't' }); markText(t, r.title, query);
    const b = el('button', { class: 'note-row', type: 'button', onclick: () => {
      if (r.kind === 'folder') openFolder(r.id);
      else openNote(r.kind === 'file' ? r.noteId : r.id, { highlight: query, att: r.kind === 'file' ? r.id : null });
    } }, el('div', { class: 'kind' }, kind), t, p);
    listEl.append(el('li', {}, b));
  }
}
for (const [inp, list, other] of [['#search-folders', '#search-results-folders', '#folder-list'], ['#search-notes', '#search-results-notes', '#note-list']]) {
  $(inp).addEventListener('input', (e) => renderResults($(list), $(other), e.target.value));
}

function highlightInEditor(q) {
  if (!window.CSS?.highlights || !q) return;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const ranges = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let first = null;
  while (walker.nextNode()) {
    const node = walker.currentNode, low = node.data.toLowerCase();
    for (const w of words) {
      let i = low.indexOf(w);
      while (i >= 0 && ranges.length < 200) {
        const r = new Range(); r.setStart(node, i); r.setEnd(node, i + w.length); ranges.push(r);
        first ||= node.parentElement;
        i = low.indexOf(w, i + w.length);
      }
    }
  }
  CSS.highlights.set('treffer', new Highlight(...ranges));
  first?.scrollIntoView({ block: 'center' });
}

// ================= Editor =================
function setStatus(t) { $('#save-status').textContent = t; }

function noteDateText(n) {
  const d = new Date(n.modified);
  return d.toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' }) + ' um ' + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

async function openNote(id, { focus = false, highlight = '', att = null } = {}) {
  if (S.noteId && S.noteId !== id) await closeEditor();
  const n = noteById(id);
  if (!n) return;
  S.noteId = id;
  editor.innerHTML = sanitizeHtml(n.html || '') || '<h1><br></h1>';
  hydrate();
  const trashed = !!n.deleted;
  editor.contentEditable = trashed ? 'false' : 'true';
  $('#trash-banner').hidden = !trashed;
  $('#editor-tools').hidden = trashed;
  $('#format-panel').hidden = true;
  $('#note-date').textContent = noteDateText(n);
  setStatus('');
  app.classList.add('has-note');
  renderNotes();
  setView('editor');
  $('#editor-scroll').scrollTop = 0;
  if (window.CSS?.highlights) CSS.highlights.delete('treffer');
  if (highlight) setTimeout(() => highlightInEditor(highlight), 60);
  if (att) setTimeout(() => editor.querySelector(`.att[data-att="${CSS.escape(att)}"]`)?.scrollIntoView({ block: 'center' }), 80);
  if (focus) {
    const r = document.createRange(); r.selectNodeContents(editor.lastElementChild || editor); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); editor.focus();
  }
}

/** Schliesst die Notiz: speichert, leere neue Notizen werden verworfen. */
async function closeEditor() {
  if (!S.noteId) return;
  await saveNow();
  const n = noteById(S.noteId);
  if (n && !n.deleted && !n.text?.trim() && !/<img|data-att/.test(n.html || '')) {
    await db.del('notes', n.id);
    S.notes = S.notes.filter((x) => x.id !== n.id);
    S.index = null;
  }
  S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = [];
  S.noteId = null;
  editor.innerHTML = '';
  app.classList.remove('has-note');
  render();
}

function scheduleSave() {
  setStatus('…');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 600);
}

function deriveTitle(blocks) {
  for (const b of blocks) {
    if (b.runs) { const t = runsText(b.runs).split('\n').map((x) => x.trim()).find(Boolean); if (t) return t.slice(0, 120); }
    if (b.type === 'table') { const t = b.rows[0]?.cells.map((c) => runsText(c).trim()).filter(Boolean).join(' · '); if (t) return t.slice(0, 120); }
    if (b.type === 'att') return attName(b.id);
    if (b.type === 'img') return 'Bild';
  }
  return 'Neue Notiz';
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  const n = noteById(S.noteId);
  if (!n || n.deleted) return;
  const html = ed.serializeEditor();
  if (html === n.html) { setStatus(n.text ? 'Gespeichert' : ''); return; }
  const blocks = htmlToBlocks(html);
  n.html = html;
  n.text = blocksToText(blocks, (id) => `[Anhang: ${attName(id)}]`).trim();
  n.title = deriveTitle(blocks);
  n.modified = Date.now();
  try {
    await db.put('notes', n);
    setStatus('Gespeichert');
  } catch (e) {
    setStatus('Fehler!');
    infoDialog('Speichern fehlgeschlagen', [String(e.message || e), 'Bitte eine ZIP-Sicherung erstellen und Speicherplatz prüfen.']);
    return;
  }
  $('#note-date').textContent = noteDateText(n);
  S.index = null;
  if (matchMedia('(min-width: 900px)').matches) renderNotes();
  scheduleSync([n.id]);
}

async function newNote(title = '') {
  if (S.noteId) await closeEditor();
  if (typeof title !== 'string') title = '';
  const folderId = S.folderId === 'all' || S.folderId === 'trash' ? realFolder(localStorage.getItem('lastRealFolder')) : S.folderId;
  const n = { id: db.newId('n-'), folderId, html: title ? `<h1>${escapeText(title)}</h1><p><br></p>` : '<h1><br></h1>', title: title || 'Neue Notiz', text: title, created: Date.now(), modified: Date.now(), pinned: false, deleted: false };
  S.notes.push(n);
  await db.put('notes', n);
  if (S.folderId === 'trash') S.folderId = folderId;
  if (app.dataset.view === 'folders') { app.dataset.view = 'notes'; history.pushState({ view: 'notes' }, ''); S.depth++; }
  renderNotes();
  await openNote(n.id, { focus: true });
  return n;
}

// ---------- Anhaenge ----------
function hydrate(root = editor) {
  for (const card of root.querySelectorAll('.att[data-att]')) {
    if (card.querySelector('.att-head')) continue;
    card.contentEditable = 'false';
    const f = S.files.get(card.dataset.att);
    card.replaceChildren();
    if (!f) { card.append(el('div', { class: 'att-info' }, 'Anhang fehlt'), el('div', { class: 'att-actions' }, el('button', { type: 'button', class: 'danger', 'data-act': 'remove' }, 'Entfernen'))); continue; }
    const kind = f.kind;
    const ext = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const icon = el('div', { class: 'att-icon' + (kind === 'audio' ? ' audio' : '') }, kind === 'audio' ? '🎙' : kind === 'pdf' ? 'PDF' : ext || 'DATEI');
    const info = [formatSize(f.size)];
    if (f.duration) info.push(`${Math.floor(f.duration / 60)}:${String(Math.round(f.duration % 60)).padStart(2, '0')} min`);
    info.push(new Date(f.created).toLocaleDateString('de-CH'));
    if (f.fromApp) info.push('PDF erstellt von Notizen');
    card.append(el('div', { class: 'att-head' }, icon, el('div', { class: 'att-meta' }, el('div', { class: 'att-name' }, f.name), el('div', { class: 'att-info' }, info.join(' · ')))));
    if (kind === 'pdf' && (f.preview || f.text)) {
      const pv = el('div', { class: 'att-preview' });
      if (f.preview) pv.append(el('img', { src: f.preview, alt: 'Vorschau' })); else pv.textContent = f.text.slice(0, 400);
      card.append(pv);
    }
    if (kind === 'audio') {
      const url = URL.createObjectURL(f.blob); S.urls.push(url);
      card.append(el('audio', { controls: true, preload: 'metadata', src: url }));
    }
    card.append(el('div', { class: 'att-actions' },
      kind !== 'audio' ? el('button', { type: 'button', 'data-act': 'open' }, 'Öffnen') : null,
      el('button', { type: 'button', 'data-act': 'share' }, 'Teilen'),
      el('button', { type: 'button', 'data-act': 'save' }, 'Herunterladen'),
      el('button', { type: 'button', class: 'danger', 'data-act': 'remove' }, 'Entfernen')));
  }
}

async function addAttachment({ blob, name, type, kind, text = '', preview = null, fromApp = false, duration = 0 }) {
  const f = { id: db.newId('a-'), noteId: S.noteId, name, type, size: blob.size, kind, blob, text, preview, fromApp, duration, created: Date.now() };
  await db.put('files', f);
  S.files.set(f.id, f);
  ed.insertHtml(`<div class="att" data-att="${f.id}" contenteditable="false">Anhang</div><p><br></p>`, { clean: false });
  hydrate();
  S.index = null;
  return f;
}

async function attachmentAction(act, card) {
  const f = S.files.get(card.dataset.att);
  if (act === 'remove') {
    if (!(await confirmDialog('Anhang entfernen?', f ? `«${f.name}» wird aus der Notiz gelöscht.` : '', 'Entfernen', true))) return;
    card.remove();
    if (f) { await db.del('files', f.id); S.files.delete(f.id); }
    editor.dispatchEvent(new Event('input'));
    return;
  }
  if (!f) return;
  const file = new File([f.blob], f.name, { type: f.type || 'application/octet-stream' });
  if (act === 'share') return shareFiles([file], f.name);
  if (act === 'save') return download(file, f.name);
  if (act === 'open') {
    const url = URL.createObjectURL(file); S.urls.push(url);
    const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
    if (f.kind !== 'pdf' && !/^(image|text)\//.test(f.type)) a.download = f.name;
    document.body.append(a); a.click(); a.remove();
  }
}

editor.addEventListener('click', (e) => {
  const btn = e.target.closest('.att [data-act]');
  if (btn) { e.preventDefault(); attachmentAction(btn.dataset.act, btn.closest('.att')); return; }
  if (editor.isContentEditable) ed.handleChecklistClick(e);
});
editor.addEventListener('input', () => { if (!noteById(S.noteId)?.deleted) scheduleSave(); });
editor.addEventListener('focusin', () => { $('#btn-done').hidden = false; });
editor.addEventListener('focusout', () => { setTimeout(() => { if (!editor.contains(document.activeElement)) $('#btn-done').hidden = true; }, 150); });

// ---------- Einfuegen (Pflicht-Abfrage) ----------
const importCtx = {
  insertHtml: (h) => { ed.insertHtml(h, { clean: false }); hydrate(); },
  addAttachment,
};
editor.addEventListener('copy', () => { S.lastCopy = getSelection().toString(); });
editor.addEventListener('cut', () => { S.lastCopy = getSelection().toString(); });
editor.addEventListener('paste', async (e) => {
  if (!editor.isContentEditable) return;
  const cd = e.clipboardData;
  const files = [...(cd?.files || [])];
  const html = cd?.getData('text/html') || '';
  const text = cd?.getData('text/plain') || '';
  e.preventDefault();
  // Text, der eben in dieser App kopiert wurde, wird ohne Abfrage eingefuegt
  if (!files.length && text && text === S.lastCopy) { ed.insertHtml(html || escapeText(text).replace(/\n/g, '<br>')); hydrate(); return; }
  const items = files.length ? parseShared({ files }) : parseShared({ html, text: html ? '' : text });
  if (html && !files.length && /^https?:\/\/\S+$/.test(text.trim())) items.splice(0, items.length, ...parseShared({ url: text.trim() }));
  await importItems(items, importCtx);
});
editor.addEventListener('drop', async (e) => {
  if (!editor.isContentEditable || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  await importItems(parseShared({ files: [...e.dataTransfer.files] }), importCtx);
});

// ---------- Werkzeugleiste ----------
// pointerdown + preventDefault: Fokus/Tastatur bleibt im Editor
function keepFocus(elm) { elm.addEventListener('pointerdown', (e) => e.preventDefault()); }
document.querySelectorAll('#format-panel button, #table-tools button, #tb-format, #tb-check, #tb-table, #tb-undo').forEach(keepFocus);
$('#tb-format').onclick = () => { $('#format-panel').hidden = !$('#format-panel').hidden; };
$('#format-panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.fmt) ed.format(b.dataset.fmt);
  if (b.dataset.size) ed.format('size', b.dataset.size);
  if (b.dataset.color) ed.format('color', b.dataset.color);
  if (b.dataset.clear) { ed.restoreSelection(); document.execCommand('removeFormat'); editor.dispatchEvent(new Event('input')); }
  updateFormatState();
});
for (const [name, c] of COLORS) $('#colors').append(el('button', { type: 'button', 'data-color': c, 'aria-label': `Farbe ${name}`, title: name, style: `background:${c}` }));
$('#colors').append(el('button', { type: 'button', 'data-clear': '1', 'aria-label': 'Formatierung entfernen', title: 'Formatierung entfernen', class: 'clear-fmt' }, '⌫'));
$('#colors').querySelectorAll('button').forEach(keepFocus);
$('#tb-check').onclick = () => ed.format('checklist');
$('#tb-table').onclick = () => ed.insertTable(3, 3);
$('#tb-undo').onclick = () => ed.format('undo');
$('#table-tools').addEventListener('click', async (e) => {
  const a = e.target.closest('button')?.dataset.table;
  if (!a) return;
  if (a === 'delTable') {
    const cell = ed.currentCell();
    if (!(await confirmDialog('Tabelle löschen?', 'Die ganze Tabelle mit allen Einträgen wird entfernt.', 'Löschen', true))) return;
    if (cell) { const r = document.createRange(); r.selectNodeContents(cell); getSelection().removeAllRanges(); getSelection().addRange(r); }
  }
  ed.tableAction(a);
});
function updateFormatState() {
  for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough']) {
    let on = false; try { on = document.queryCommandState(cmd); } catch {}
    $(`#format-panel [data-fmt="${cmd}"]`)?.classList.toggle('on', on);
  }
}
document.addEventListener('selectionchange', () => {
  const inEditor = editor.contains(getSelection().anchorNode);
  if (!inEditor) return;
  $('#table-tools').hidden = !ed.currentCell();
  if (!$('#format-panel').hidden) updateFormatState();
});

// Fotos / Kamera / Scan
$('#tb-photo').onclick = async () => {
  const r = await dialog({ title: 'Bild einfügen', buttons: [{ id: 'camera', label: 'Foto aufnehmen', kind: 'primary' }, { id: 'scan', label: 'Dokument scannen (Schwarz-Weiss)' }, { id: 'gallery', label: 'Aus Galerie wählen' }] });
  if (r) $(`#in-${r}`).click();
};
for (const id of ['gallery', 'camera', 'scan']) {
  $(`#in-${id}`).addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      try {
        const src = await imageToJpeg(f, id === 'scan' ? { max: 2200, quality: 0.85, scan: true } : { max: 1600, quality: 0.85 });
        ed.insertHtml(`<p><img src="${src}" alt="${escapeAttr(id === 'scan' ? 'Scan' : 'Foto')}"></p><p><br></p>`, { clean: false });
      } catch (err) { toast('Bild konnte nicht gelesen werden: ' + (err.message || err)); }
    }
  });
}
$('#tb-file').onclick = () => $('#in-file').click();
$('#in-file').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) await importItems(parseShared({ files }), importCtx);
});

// Sprachmemo
$('#tb-audio').onclick = async () => {
  if (!recordingSupported()) return infoDialog('Keine Aufnahme möglich', 'Dieser Browser unterstützt keine Tonaufnahme.');
  let rec;
  try { rec = await startRecording(); }
  catch (e) { return infoDialog('Mikrofon nicht verfügbar', ['Die App darf das Mikrofon nicht benutzen oder es ist belegt.', 'Erlauben: Chrome-Menü ⋮ > Einstellungen > Website-Einstellungen > Mikrofon.']); }
  const started = Date.now();
  let timer;
  const r = await dialog({
    title: 'Sprachmemo',
    buttons: [{ id: 'stop', label: 'Stopp und einfügen', kind: 'primary' }],
    cancelLabel: 'Verwerfen',
    build(body) {
      const t = el('div', { class: 'rec-time' }, el('span', { class: 'rec-dot' }), '0:00');
      body.append(t, el('p', { class: 'dlg-text' }, 'Aufnahme läuft …'));
      timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); t.lastChild.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 250);
    },
  });
  clearInterval(timer);
  if (r !== 'stop') { rec.cancel(); return; }
  const blob = await rec.stop();
  const d = new Date();
  const name = `Sprachmemo ${d.toLocaleDateString('de-CH')} ${d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }).replace(':', '.')}.${audioExt(blob.type)}`;
  await addAttachment({ blob, name, type: blob.type, kind: 'audio', duration: (Date.now() - started) / 1000 });
};

// ---------- Kopfzeile Editor ----------
$('#back-notes').onclick = () => goBack('notes');
$('#back-folders').onclick = () => goBack('folders');
$('#btn-done').onclick = () => { editor.blur(); $('#format-panel').hidden = true; saveNow(); };

$('#btn-share').onclick = async () => {
  await saveNow();
  const n = noteById(S.noteId);
  if (!n) return;
  const atts = [...editor.querySelectorAll('.att[data-att]')].map((c) => S.files.get(c.dataset.att)).filter(Boolean);
  const buttons = [{ id: 'pdf', label: 'Als PDF senden', kind: 'primary' }];
  if (atts.length) buttons.push({ id: 'pdfatt', label: `PDF + ${atts.length} Anhang/Anhänge senden` });
  buttons.push({ id: 'text', label: 'Als Text senden' }, { id: 'txt', label: 'Als Textdatei (.txt) senden' }, { id: 'print', label: 'Drucken / als PDF sichern' });
  const r = await dialog({ title: 'Notiz teilen', text: 'E-Mail, WhatsApp und andere Apps erscheinen im nächsten Schritt.', buttons });
  if (!r) return;
  try {
    if (r === 'pdf' || r === 'pdfatt') {
      setStatus('PDF …');
      const pdf = await notePdf(n, attName);
      setStatus('Gespeichert');
      const files = [pdf, ...(r === 'pdfatt' ? atts.map((f) => new File([f.blob], f.name, { type: f.type })) : [])];
      await shareFiles(files, n.title);
    } else if (r === 'text') await shareText(n.title, noteText(n, attName));
    else if (r === 'txt') await shareFiles([new File([noteText(n, attName)], (n.title || 'Notiz').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + '.txt', { type: 'text/plain' })], n.title);
    else if (r === 'print') doPrint(n);
  } catch (e) { setStatus(''); infoDialog('Teilen fehlgeschlagen', String(e.message || e)); }
};

function doPrint(n) {
  const html = sanitizeHtml(n.html).replace(/<div class="att" data-att="([^"]+)"[^>]*><\/div>/g, (m, id) => `<p class="att">📎 ${escapeText(attName(id))}</p>`);
  printNote(html);
}

$('#btn-more').onclick = async () => {
  const n = noteById(S.noteId);
  if (!n) return;
  if (n.deleted) {
    const r = await dialog({ title: 'Gelöschte Notiz', buttons: [{ id: 'restore', label: 'Wiederherstellen', kind: 'primary' }, { id: 'forever', label: 'Endgültig löschen', kind: 'danger' }] });
    if (r === 'restore') restoreNote(n.id);
    if (r === 'forever' && (await confirmDialog('Endgültig löschen?', 'Die Notiz und ihre Anhänge werden unwiderruflich gelöscht.', 'Löschen', true))) { await deleteForever(n.id); goBack('notes'); }
    return;
  }
  const r = await dialog({ title: n.title, buttons: [
    { id: 'pin', label: n.pinned ? 'Nicht mehr anheften' : 'Anheften' },
    { id: 'move', label: 'In Ordner verschieben' },
    { id: 'print', label: 'Drucken / als PDF sichern' },
    { id: 'delete', label: 'Notiz löschen', kind: 'danger' }] });
  if (r === 'pin') { n.pinned = !n.pinned; await db.put('notes', n); renderNotes(); toast(n.pinned ? 'Angeheftet' : 'Nicht mehr angeheftet'); }
  if (r === 'move') {
    const target = await pickFolder('Notiz verschieben nach', { current: n.folderId });
    if (target && target !== n.folderId) { await saveNow(); n.folderId = target; n.modified = Date.now(); await db.put('notes', n); S.index = null; render(); scheduleSync([n.id]); toast(`Verschoben nach «${folderPathStr(target)}»`); }
  }
  if (r === 'print') { await saveNow(); doPrint(n); }
  if (r === 'delete') {
    await saveNow();
    n.deleted = Date.now(); await db.put('notes', n); S.index = null;
    scheduleSync([n.id]);
    toast('In «Zuletzt gelöscht» verschoben (30 Tage).');
    goBack('notes');
  }
};
$('#btn-restore').onclick = () => restoreNote(S.noteId);

async function restoreNote(id) {
  const n = noteById(id);
  if (!n) return;
  n.deleted = false; n.folderId = realFolder(n.folderId); n.modified = Date.now();
  await db.put('notes', n); S.index = null;
  scheduleSync([n.id]);
  toast(`Wiederhergestellt in «${folderPathStr(n.folderId)}»`);
  await openNote(n.id);
}

async function deleteForever(id, rerender = true) {
  const n = noteById(id);
  if (!n) return;
  const files = [...S.files.values()].filter((f) => f.noteId === id);
  await db.delMany('files', files.map((f) => f.id));
  files.forEach((f) => S.files.delete(f.id));
  await db.del('notes', id);
  S.notes = S.notes.filter((x) => x.id !== id);
  if (S.noteId === id) { S.noteId = null; app.classList.remove('has-note'); }
  S.index = null;
  scheduleSync(null);
  if (rerender) render();
}

$('#btn-empty-trash').onclick = async () => {
  const list = notesIn('trash');
  if (!(await confirmDialog('Alle gelöschten Notizen entfernen?', `${list.length} Notiz(en) werden endgültig gelöscht.`, 'Endgültig löschen', true))) return;
  for (const n of list) await deleteForever(n.id, false);
  render();
};
$('#btn-new-note').onclick = newNote;
$('#btn-new-note-f').onclick = newNote;

// ================= Ordner-Aktionen =================
function pickFolder(title, { current = null, exclude = [], allowRoot = false } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    dialog({
      title, buttons: [],
      build(body, close) {
        const ul = el('ul', { class: 'pick-list' });
        if (allowRoot) ul.append(el('li', {}, el('button', { type: 'button', onclick: () => { chosen = '__root'; close('ok'); } }, 'Oberste Ebene')));
        for (const { folder, depth } of flattenTree(S.folders)) {
          if (exclude.includes(folder.id)) continue;
          const b = el('button', { type: 'button', class: folder.id === current ? 'on' : '', onclick: () => { chosen = folder.id; close('ok'); } }, svg('folder'), folder.name);
          b.style.paddingLeft = `${8 + depth * 20}px`;
          ul.append(el('li', {}, b));
        }
        body.append(ul);
      },
    }).then(() => resolve(chosen));
  });
}

async function createFolder(parentId = null) {
  let parent = parentId;
  const name = await promptDialog({
    title: parentId ? 'Neuer Unterordner' : 'Neuer Ordner', label: 'Name', okLabel: 'Erstellen',
    extra: parentId ? (body) => body.append(el('p', { class: 'dlg-text' }, `In «${folderPathStr(parentId)}»`)) : (body) => {
      const sel = el('select', { class: 'field', 'aria-label': 'Ablageort' }, el('option', { value: '' }, 'Oberste Ebene'),
        ...flattenTree(S.folders).map(({ folder, depth }) => el('option', { value: folder.id }, '\u00a0\u00a0'.repeat(depth) + 'in ' + folder.name)));
      sel.onchange = () => { parent = sel.value || null; };
      body.append(el('label', { class: 'dlg-label' }, 'Ablageort'), sel);
    },
  });
  if (name == null) return;
  const v = validateFolderName(S.folders, name, parent);
  if (!v.ok) { await infoDialog('Ordner nicht erstellt', v.error); return; }
  const f = { id: db.newId('f-'), name: v.name, parentId: parent, created: Date.now() };
  await db.put('folders', f); S.folders.push(f); S.index = null;
  if (parent) S.collapsed.delete(parent);
  renderFolders();
  toast(`Ordner «${f.name}» erstellt`);
}
$('#btn-new-folder').onclick = () => createFolder(null);

async function folderActions(id) {
  const f = S.folders.find((x) => x.id === id);
  if (!f) return;
  const r = await dialog({ title: f.name, buttons: [{ id: 'rename', label: 'Umbenennen' }, { id: 'sub', label: 'Neuer Unterordner' }, { id: 'move', label: 'Verschieben' }, { id: 'delete', label: 'Ordner löschen', kind: 'danger' }] });
  if (r === 'rename') {
    const name = await promptDialog({ title: 'Ordner umbenennen', value: f.name });
    if (name == null) return;
    const v = validateFolderName(S.folders, name, f.parentId, f.id);
    if (!v.ok) return infoDialog('Nicht umbenannt', v.error);
    f.name = v.name; await db.put('folders', f);
    afterFolderChange();
  }
  if (r === 'sub') await createFolder(id);
  if (r === 'move') {
    const target = await pickFolder(`«${f.name}» verschieben nach`, { current: f.parentId, exclude: descendantIds(S.folders, id), allowRoot: true });
    if (!target) return;
    const parentId = target === '__root' ? null : target;
    if (!canMoveFolder(S.folders, id, parentId)) return infoDialog('Nicht möglich', 'Ein Ordner kann nicht in sich selbst verschoben werden.');
    const v = validateFolderName(S.folders, f.name, parentId, f.id);
    if (!v.ok) return infoDialog('Nicht verschoben', v.error);
    f.parentId = parentId; await db.put('folders', f);
    afterFolderChange();
  }
  if (r === 'delete') {
    if (id === DEFAULT_FOLDER) return infoDialog('Nicht möglich', 'Der Hauptordner kann nicht gelöscht werden. Du kannst ihn aber umbenennen.');
    const plan = planDeleteFolder(S.folders, S.notes, id);
    const subs = plan.folderIds.length - 1;
    const text = [`${subs ? `${subs} Unterordner und ` : ''}${plan.noteIds.length} Notiz(en) sind betroffen.`, 'Die Notizen kommen in «Zuletzt gelöscht» und können 30 Tage lang wiederhergestellt werden.'];
    if (!(await confirmDialog(`Ordner «${f.name}» löschen?`, text, 'Ordner löschen', true))) return;
    const now = Date.now();
    for (const nid of plan.noteIds) { const n = noteById(nid); n.deleted = now; await db.put('notes', n); }
    await db.delMany('folders', plan.folderIds);
    S.folders = S.folders.filter((x) => !plan.folderIds.includes(x.id));
    if (plan.folderIds.includes(S.folderId)) S.folderId = 'all';
    afterFolderChange();
    toast('Ordner gelöscht');
  }
}
function afterFolderChange() { S.index = null; render(); scheduleSync(null); }

// ================= Sicherung =================
function scheduleSync(ids) {
  if (ids === null) S.syncIds.add('*'); else ids.forEach((i) => S.syncIds.add(i));
  clearTimeout(S.syncTimer);
  S.syncTimer = setTimeout(runSync, 1500);
}
async function runSync() {
  const ids = [...S.syncIds]; S.syncIds.clear();
  const res = await backup.syncFolder({ onlyIds: ids.includes('*') ? null : ids });
  S.syncProblem = res.status === 'prompt' ? 'prompt' : res.status === 'error' ? res.error : null;
  if (res.status === 'ok' && S.noteId && $('#save-status').textContent === 'Gespeichert') setStatus('Gespeichert · Ordner ✓');
  updateBanner();
}

async function updateBanner() {
  const b = $('#banner');
  const handle = await backup.getDirHandle();
  b.replaceChildren(); b.hidden = true;
  if (handle && S.syncProblem === 'prompt') {
    b.append('Ordner-Sicherung pausiert – der Browser braucht deine Erlaubnis.', el('button', { class: 'text-btn', type: 'button', onclick: async () => {
      if ((await backup.permission(handle, true)) === 'granted') { S.syncProblem = null; scheduleSync(null); toast('Ordner-Sicherung läuft wieder'); }
      updateBanner();
    } }, 'Fortsetzen'));
    b.hidden = false; return;
  }
  if (handle && S.syncProblem) {
    b.append(`Ordner-Sicherung fehlgeschlagen: ${S.syncProblem}`, el('button', { class: 'text-btn', type: 'button', onclick: openSettings }, 'Details'));
    b.hidden = false; return;
  }
  if (!handle && S.notes.some((n) => !n.deleted && n.text)) {
    const last = await db.getMeta('lastBackup', 0);
    const days = Math.floor((Date.now() - last) / 864e5);
    if (!last || days >= REMIND_DAYS) {
      b.append(last ? `Letzte Sicherung vor ${days} Tagen.` : 'Noch keine Sicherung ausserhalb der App.', el('button', { class: 'text-btn', type: 'button', onclick: openSettings }, 'Jetzt sichern'));
      b.hidden = false;
    }
  }
}

async function makeZip() {
  toast('Sicherung wird erstellt …', 8000);
  await saveNow();
  const blob = await backup.buildBackupZip();
  await db.setMeta('lastBackup', Date.now());
  updateBanner();
  return new File([blob], backup.backupFileName(), { type: 'application/zip' });
}

async function openSettings() {
  const handle = await backup.getDirHandle();
  const perm = handle ? await backup.permission(handle) : 'none';
  const last = await db.getMeta('lastBackup', 0);
  const lastSync = await db.getMeta('lastFolderSync', 0);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const when = (t) => (t ? new Date(t).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie');
  await dialog({
    title: 'Sicherung & Speicher', className: 'settings', buttons: [], cancelLabel: 'Schliessen',
    build(body, close) {
      body.append(el('h3', {}, 'Automatische Ordner-Sicherung'));
      if (!backup.folderSyncSupported()) {
        body.append(el('p', {}, 'Dieser Browser erlaubt keinen direkten Zugriff auf einen Ordner. Bitte die ZIP-Sicherung unten verwenden.'));
      } else if (!handle) {
        body.append(el('p', {}, 'Wähle einmal einen Ordner, z. B. «Dokumente» und dort einen neuen Ordner «Notizen». Danach schreibt die App jede Notiz automatisch als lesbare .html- und .txt-Datei samt Anhängen dorthin. Die Dateien bleiben erhalten, auch wenn die App gelöscht wird.'),
          el('button', { class: 'btn primary', type: 'button', onclick: async () => {
            try { await backup.chooseFolder(); close('chosen'); S.syncProblem = null; toast('Ordner gewählt – alle Notizen werden geschrieben …'); scheduleSync(null); }
            catch (e) { if (e.name !== 'AbortError') infoDialog('Ordner nicht verfügbar', [String(e.message || e), 'Android erlaubt keine Systemordner wie «Download» direkt. Bitte einen eigenen Unterordner wählen oder neu erstellen.']); }
          } }, 'Ordner wählen …'));
      } else {
        body.append(el('p', {}, 'Ordner: ', el('b', {}, handle.name), ' · ', perm === 'granted' ? el('span', { class: 'status-ok' }, 'aktiv') : el('span', { class: 'status-warn' }, 'Erlaubnis nötig')),
          el('p', { class: 'muted' }, `Zuletzt geschrieben: ${when(lastSync)}`));
        if (perm !== 'granted') body.append(el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          if ((await backup.permission(handle, true)) === 'granted') { S.syncProblem = null; scheduleSync(null); close('ok'); toast('Ordner-Sicherung aktiv'); }
        } }, 'Zugriff erneut erlauben'));
        body.append(el('button', { class: 'btn', type: 'button', onclick: async () => { close('ok'); await db.setMeta('syncState', {}); toast('Alle Notizen werden neu geschrieben …'); scheduleSync(null); } }, 'Alles neu schreiben'),
          el('button', { class: 'btn', type: 'button', onclick: async () => { await backup.stopFolderSync(); close('ok'); updateBanner(); toast('Ordner-Sicherung beendet (Dateien bleiben im Ordner).'); } }, 'Ordner-Sicherung beenden'));
      }
      body.append(el('h3', {}, 'ZIP-Sicherung'),
        el('p', {}, `Alle Notizen, Ordner und Anhänge in einer Datei. Letzte ZIP-Sicherung: ${when(last)}.`),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => { const f = await makeZip(); download(f, f.name); toast('ZIP liegt im Ordner «Downloads».'); } }, 'ZIP herunterladen'),
        el('button', { class: 'btn', type: 'button', onclick: async () => { const f = await makeZip(); await shareFiles([f], f.name); } }, 'ZIP teilen (z. B. Google Drive, E-Mail)'),
        el('button', { class: 'btn', type: 'button', onclick: () => { close('ok'); $('#in-restore').click(); } }, 'Aus ZIP wiederherstellen …'));
      body.append(el('h3', {}, 'Speicher in der App'),
        el('p', {}, persisted ? 'Dauerhafter Speicher: ja (Browser löscht die Daten nicht von sich aus).' : 'Dauerhafter Speicher: noch nicht bestätigt. Tipp: App auf dem Startbildschirm installieren.'),
        est ? el('p', { class: 'muted' }, `Belegt: ${formatSize(est.usage || 0)}`) : null);
      if (S.installPrompt) body.append(el('button', { class: 'btn', type: 'button', onclick: async () => { S.installPrompt.prompt(); S.installPrompt = null; close('ok'); } }, 'App auf Startbildschirm installieren'));
      body.append(el('p', { class: 'muted small' }, `Notizen Version ${APP_VERSION} · Alles bleibt auf diesem Gerät, kein Konto, keine Cloud.`));
    },
  });
}
$('#btn-settings').onclick = openSettings;

$('#in-restore').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = await backup.readBackupZip(file);
    const ok = await confirmDialog('Sicherung wiederherstellen?', [`${data.notes.length} Notizen, ${data.folders.length} Ordner, ${data.files.length} Anhänge.`, 'Vorhandene Notizen bleiben erhalten. Gleiche Notizen werden mit dem Stand der Sicherung überschrieben.'], 'Wiederherstellen');
    if (!ok) return;
    if (S.noteId) await closeEditor();
    await db.putMany('folders', data.folders);
    await db.putMany('notes', data.notes);
    await db.putMany('files', data.files);
    await loadAll(); render(); scheduleSync(null);
    toast('Sicherung wiederhergestellt');
  } catch (err) { infoDialog('Wiederherstellen fehlgeschlagen', String(err.message || err)); }
});

// ================= Teilen-Menue (Web Share Target) =================
async function handleSharedInbox() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share')) return;
  history.replaceState({ view: app.dataset.view }, '', location.pathname);
  let items = [];
  try { items = await db.takeInbox(); } catch (e) { console.error(e); }
  if (params.get('share') === 'error') return infoDialog('Teilen fehlgeschlagen', 'Der geteilte Inhalt konnte nicht gelesen werden.');
  for (const it of items) {
    const files = (it.files || []).map((f) => new File([f.blob], f.name || 'Datei', { type: f.type || f.blob.type || '' }));
    const parsed = parseShared({ text: it.text, url: it.url, files });
    if (!parsed.length) continue;
    await newNote(it.title || '');
    await importItems(parsed, importCtx);
    await saveNow();
  }
}

// ================= Start =================
async function start() {
  ed.initEditor(editor);
  try { S.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch {}
  await loadAll();
  await housekeeping();
  S.folderId = localStorage.getItem('folder') || 'all';
  if (S.folderId !== 'all' && S.folderId !== 'trash' && !S.folders.some((f) => f.id === S.folderId)) S.folderId = 'all';
  history.replaceState({ view: 'folders' }, '');
  render();
  await handleSharedInbox();
  scheduleSync(null);
  updateBanner();
  // Dauerhaften Speicher anfragen (Chrome entscheidet selbst, v. a. bei installierter App)
  addEventListener('pointerdown', () => navigator.storage?.persist?.().catch(() => {}), { once: true });
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  addEventListener('pagehide', () => saveNow());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { scope: './' }).catch((e) => console.warn('SW', e));
}
start().catch((e) => { console.error(e); infoDialog('Start fehlgeschlagen', String(e.message || e)); });

// Fuer automatische Tests im Browser
window.__notizen = { S, saveNow, newNote, openNote, closeEditor, openFolder, importItems: (items) => importItems(items, importCtx), parseShared, makeZip, backup, ed };
