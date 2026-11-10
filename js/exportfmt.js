// Formate fuer lesbare Dateien (Ordner-Sicherung, ZIP, Teilen).
// Reine Funktionen: Dateinamen, eigenstaendiges HTML, Anhangs-Links.
import { parseHtml, serialize, escapeText, escapeAttr } from './htmlparse.js';

/** Macht aus einem Titel einen gueltigen Dateinamen (Android/Windows/macOS). */
export function safeFileName(name, fallback = 'Notiz') {
  let s = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

/**
 * Vergibt pro Ordner eindeutige Dateinamen (ohne Endung).
 * Aeltere Notizen behalten ihren Namen; bei Gleichstand bekommt die neuere " (2)" usw.
 * notes: [{ id, title, created }] -> Map id -> Name
 */
export function assignFileNames(notes) {
  const sorted = [...notes].sort((a, b) => (a.created || 0) - (b.created || 0) || String(a.id).localeCompare(String(b.id)));
  const used = new Set();
  const map = new Map();
  for (const n of sorted) {
    const base = safeFileName(n.title, 'Neue Notiz');
    let name = base, k = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${k++})`;
    used.add(name.toLowerCase());
    map.set(n.id, name);
  }
  return map;
}

/** Eindeutige Namen fuer Anhaenge einer Notiz. files: [{id, name}] -> Map id -> Name */
export function assignAttachmentNames(files) {
  const used = new Set();
  const map = new Map();
  for (const f of files) {
    const raw = safeFileName(f.name, 'Anhang');
    const dot = raw.lastIndexOf('.');
    const stem = dot > 0 ? raw.slice(0, dot) : raw, ext = dot > 0 ? raw.slice(dot) : '';
    let name = raw, k = 2;
    while (used.has(name.toLowerCase())) name = `${stem} (${k++})${ext}`;
    used.add(name.toLowerCase());
    map.set(f.id, name);
  }
  return map;
}

/** Ersetzt Anhangskarten im Notiz-HTML durch Links/Audio-Player auf relative Dateien. */
export function linkAttachments(html, links) {
  const tree = parseHtml(html);
  const fix = (node) => {
    if (node.type !== 'el' && node.type !== 'root') return node;
    node.children = node.children.map((c) => {
      if (c.type === 'el' && c.tag === 'div' && /\batt\b/.test(c.attrs.class || '')) {
        const l = links.get(c.attrs['data-att']);
        if (!l) return { type: 'el', tag: 'p', attrs: { class: 'att' }, children: [{ type: 'text', text: '[Anhang fehlt]' }] };
        const a = { type: 'el', tag: 'a', attrs: { href: l.href }, children: [{ type: 'text', text: '📎 ' + l.name }] };
        const kids = [a];
        if (l.kind === 'audio') kids.push({ type: 'el', tag: 'br', attrs: {}, children: [] }, { type: 'el', tag: 'audio', attrs: { controls: '', src: l.href }, children: [] });
        return { type: 'el', tag: 'p', attrs: { class: 'att' }, children: kids };
      }
      return fix(c);
    });
    return node;
  };
  return serialize(fix(tree));
}

const EXPORT_CSS = `body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1c1c1e}
h1{font-size:1.7em;margin:.4em 0}h2{font-size:1.3em}h3{font-size:1.1em}img{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%;margin:.6em 0}td,th{border:1px solid #888;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f0f0f0}
ul.checklist{list-style:none;padding-left:4px}ul.checklist li::before{content:"☐ ";}ul.checklist li[data-checked="true"]::before{content:"☑ ";}
ul.checklist li[data-checked="true"]{color:#888;text-decoration:line-through}.att{background:#f6f6f6;border-radius:8px;padding:8px}
.meta{color:#888;font-size:13px;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px}`;

/** Komplettes, eigenstaendiges HTML-Dokument (Bilder sind als data: eingebettet). */
export function standaloneHtml({ title, bodyHtml, folderPath = '', modified }) {
  const date = modified ? new Date(modified).toLocaleString('de-CH') : '';
  return `<!doctype html>
<html lang="de-CH"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(title || 'Notiz')}</title><style>${EXPORT_CSS}</style></head>
<body><div class="meta">${escapeText(folderPath)}${folderPath && date ? ' · ' : ''}${escapeText(date)}</div>
${bodyHtml}
</body></html>
`;
}

export { escapeText, escapeAttr };
