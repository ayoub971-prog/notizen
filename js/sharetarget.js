// Auswertung von Inhalten, die per Teilen-Menue (Web Share Target) oder
// Einfuegen (Zwischenablage) in die App kommen. Reine Funktionen.

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** Ordnet eine Datei einer Art zu: image | pdf | text | csv | audio | video | other */
export function classifyFile(name = '', type = '') {
  const n = name.toLowerCase(), t = type.toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/^image\/(jpeg|png|gif|webp|bmp|avif)$/.test(t) || /\.(jpe?g|png|gif|webp|bmp|avif)$/.test(n)) return 'image';
  if (t.startsWith('image/') || /\.(heic|heif)$/.test(n)) return 'other';
  if (t === 'text/csv' || /\.(csv|tsv)$/.test(n)) return 'csv';
  if (t.startsWith('text/') || /\.(txt|md|log|json|xml|ics|vcf)$/.test(n)) return 'text';
  if (t.startsWith('audio/') || /\.(mp3|m4a|ogg|opus|wav|webm|aac|amr)$/.test(n)) return 'audio';
  if (t.startsWith('video/') || /\.(mp4|mov|mkv)$/.test(n)) return 'video';
  return 'other';
}

/** Kann diese Art ohne Internet in ein PDF umgewandelt werden? */
export function pdfConvertible(kind) {
  return kind === 'image' || kind === 'text' || kind === 'csv' || kind === 'pdf';
}

/**
 * Macht aus geteilten Daten eine Liste von Elementen.
 * input: { title, text, url, html, files: [{ name, type, ... }] }
 * Ergebnis: [{ kind: 'html'|'text'|'url'|'file', ... }]
 * Viele Android-Apps schicken den Link im Feld "text" statt "url" - das wird erkannt.
 */
export function parseShared({ title = '', text = '', url = '', html = '', files = [] } = {}) {
  const items = [];
  title = String(title || '').trim();
  text = String(text || '').trim();
  url = String(url || '').trim();
  if (!url && text) {
    const m = URL_RE.exec(text);
    if (m) {
      url = m[0].replace(/[).,;!?]+$/, '');
      const rest = text.replace(m[0], '').trim();
      text = rest === title ? '' : rest;
    }
  }
  if (!url && URL_RE.test(title)) { // manche Apps schicken den Link im Titel
    url = URL_RE.exec(title)[0].replace(/[).,;!?]+$/, '');
    title = title.replace(URL_RE, '').trim();
  }
  if (html && html.trim()) items.push({ kind: 'html', html, title });
  else if (text) items.push({ kind: 'text', text, title });
  if (url) items.push({ kind: 'url', url, title });
  for (const f of files || []) if (f && (f.size === undefined || f.size > 0)) items.push({ kind: 'file', file: f, fileKind: classifyFile(f.name, f.type) });
  return items;
}

/** Kurze Beschreibung fuer den Auswahldialog, z. B. "Text (120 Zeichen), 2 Bilder". */
export function describeItems(items) {
  const parts = [];
  for (const it of items) {
    if (it.kind === 'html') parts.push('Formatierter Inhalt (z. B. aus einer Webseite)');
    if (it.kind === 'text') parts.push(`Text (${it.text.length} Zeichen)`);
    if (it.kind === 'url') parts.push(`Link: ${it.url.length > 60 ? it.url.slice(0, 57) + '…' : it.url}`);
  }
  const files = items.filter((i) => i.kind === 'file');
  const imgs = files.filter((f) => f.fileKind === 'image');
  if (imgs.length) parts.push(imgs.length === 1 ? 'Ein Bild' : `${imgs.length} Bilder`);
  for (const f of files) if (f.fileKind !== 'image') parts.push(`Datei «${f.file.name || 'ohne Namen'}»`);
  return parts.join(', ');
}

/** Einfacher CSV/TSV-Leser (Anfuehrungszeichen werden beachtet). */
export function parseCsv(text) {
  const src = String(text).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const first = src.split('\n')[0] || '';
  const sep = (first.match(/\t/g) || []).length > 0 ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim())).slice(0, 2000);
}
