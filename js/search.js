// Globale Volltextsuche. Alles wird im Speicher gehalten und vorab
// "normalisiert" (klein, ohne Akzente, ß -> ss), damit die Suche bei
// tausenden Notizen trotzdem sofort reagiert (einfacher Teilstring-Vergleich).
// "uber" findet "Über", "strasse" findet "Straße".

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

/**
 * Baut den Suchindex.
 * folders: [{id, name}], notes: [{id, title, text, folderId, deleted}], files: [{id, noteId, name, text}]
 */
export function buildIndex({ folders = [], notes = [], files = [], folderPath = () => '' }) {
  const entries = [];
  for (const f of folders) entries.push({ kind: 'folder', id: f.id, title: f.name, sub: folderPath(f.id), text: '', hay: normalize(f.name) });
  for (const n of notes) {
    if (n.deleted) continue;
    entries.push({ kind: 'note', id: n.id, title: n.title || 'Neue Notiz', sub: folderPath(n.folderId), text: n.text || '', modified: n.modified || 0,
      hayTitle: normalize(n.title), hay: normalize((n.title || '') + '\n' + (n.text || '')) });
  }
  const alive = new Set(notes.filter((n) => !n.deleted).map((n) => n.id));
  for (const f of files) {
    if (!alive.has(f.noteId)) continue;
    entries.push({ kind: 'file', id: f.id, noteId: f.noteId, title: f.name, sub: '', text: f.text || '', hayTitle: normalize(f.name), hay: normalize(f.name + '\n' + (f.text || '')) });
  }
  return entries;
}

/** Sucht nach allen Woertern der Anfrage (UND-Verknuepfung). */
export function search(index, query, limit = 60) {
  const words = normalize(query).trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const e of index) {
    let ok = true;
    for (const w of words) if (!e.hay.includes(w)) { ok = false; break; }
    if (!ok) continue;
    let score = 0;
    const t = e.hayTitle ?? e.hay;
    for (const w of words) if (t.includes(w)) score += t.startsWith(w) ? 3 : 2;
    if (e.kind === 'folder') score += 1;
    out.push({ ...e, score });
  }
  out.sort((a, b) => b.score - a.score || (b.modified || 0) - (a.modified || 0));
  return out.slice(0, limit);
}

/** Normalisiert zeichenweise und merkt sich, welches Originalzeichen zu welcher
 *  Stelle gehoert (ß -> ss macht den Text laenger, Akzente fallen weg). */
function normWithMap(src) {
  let norm = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const n = normalize(src[i]);
    for (const ch of n) { norm += ch; map.push(i); }
  }
  return { norm, map };
}

const queryWords = (q) => normalize(q).trim().split(' ').filter(Boolean);

/**
 * Alle Treffer der Suchwoerter in einem Text, als Positionen im ORIGINALtext:
 * [{ start, end }] (end exklusiv), sortiert, ohne Ueberlappung.
 * Beispiel: findMatches('Die Straße', 'strasse') -> [{ start: 4, end: 10 }]
 */
export function findMatches(text, query) {
  const words = queryWords(query);
  const src = String(text || '');
  if (!words.length || !src) return [];
  const { norm, map } = normWithMap(src);
  const hits = [];
  for (const w of words) {
    let p = norm.indexOf(w);
    while (p >= 0) {
      let end = map[p + w.length - 1] + 1;
      while (end < src.length && normalize(src[end]) === '') end++; // nachfolgende Akzentzeichen mitnehmen
      hits.push({ start: map[p], end });
      p = norm.indexOf(w, p + w.length);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else out.push({ ...h });
  }
  return out;
}

/** Textausschnitt rund um den ersten Treffer (fuer die Ergebnisliste). */
export function snippet(text, query, radius = 40) {
  const src = String(text || '').replace(/\s+/g, ' ');
  const m = findMatches(src, query)[0];
  if (!m) return src.slice(0, radius * 2);
  const a = Math.max(0, m.start - radius), b = Math.min(src.length, m.end + radius);
  return { before: (a > 0 ? '…' : '') + src.slice(a, m.start), match: src.slice(m.start, m.end), after: src.slice(m.end, b) + (b < src.length ? '…' : '') };
}
