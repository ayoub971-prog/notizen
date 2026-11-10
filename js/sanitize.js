// Bereinigt HTML, bevor es in eine Notiz kommt (Einfuegen, Teilen, Speichern).
// Prinzip "Erlaubnisliste": Nur bekannte, harmlose Tags/Attribute bleiben.
// - keine Skripte, keine on*-Ereignisse, keine iframes/Formulare
// - Bilder nur als eingebettete data:-Bilder (externe Bilder werden NICHT
//   geladen, sondern als Link "[Bild]" ersetzt -> keine Netzwerkanfragen)
// - Links nur http(s), mailto, tel
import { parseHtml, serialize } from './htmlparse.js';

const KEEP = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'span', 'a', 'img', 'hr', 'blockquote', 'pre', 'code', 'sub', 'sup']);
const RENAME = { h4: 'h3', h5: 'h3', h6: 'h3', font: 'span', section: 'div', article: 'div', header: 'div', footer: 'div',
  main: 'div', figure: 'div', figcaption: 'div', address: 'div', center: 'div', del: 's', ins: 'u', dl: 'div', dt: 'div', dd: 'div', caption: 'div' };
// Diese Elemente werden samt Inhalt entfernt.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'head', 'title',
  'meta', 'link', 'base', 'frame', 'frameset', 'applet', 'audio', 'video', 'canvas', 'select', 'textarea', 'button', 'input',
  'form', 'dialog', 'source', 'track', 'picture', 'map', 'area', 'colgroup', 'col', 'xmp', 'noembed', 'noframes']);
const CLASSES = new Set(['checklist', 'att', 'note-table']);
const STYLE_PROPS = new Set(['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align']);
const FONT_SIZES = { 1: '12px', 2: '14px', 3: '17px', 4: '20px', 5: '24px', 6: '30px', 7: '36px' };

export function cleanStyle(style) {
  const out = [];
  for (const decl of String(style || '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim().replace(/\s*!important\s*$/i, '');
    if (!STYLE_PROPS.has(prop) || !val) continue;
    if (/url\s*\(|expression|javascript:|[\\<>{}@]|\/\*/i.test(val)) continue;
    if ((prop === 'color' || prop === 'background-color') && !/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(val)) continue;
    if (prop === 'color' && isDefaultInk(val)) continue; // fast schwarz/weiss = Standardfarbe (sonst im Dunkelmodus unlesbar)
    if (prop === 'font-size' && !/^(\d{1,3}(\.\d+)?(px|pt|em|rem|%)|small|medium|large|x-large|xx-large|x-small|smaller|larger)$/i.test(val)) continue;
    if (prop === 'font-weight' && !/^(bold|bolder|normal|lighter|[1-9]00)$/i.test(val)) continue;
    if (prop === 'font-style' && !/^(italic|normal|oblique)$/i.test(val)) continue;
    if (prop.startsWith('text-decoration') && !/^[a-z\s-]+$/i.test(val)) continue;
    if (prop === 'text-align' && !/^(left|right|center|start|end|justify)$/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

/** true fuer (fast) schwarze, weisse oder graue Standard-Textfarben aus Webseiten. */
export function isDefaultInk(val) {
  const v = val.trim().toLowerCase();
  if (/^(black|white|inherit|initial|currentcolor|windowtext|canvastext)$/.test(v)) return true;
  let rgb = null, m;
  if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v))) rgb = [m[1] + m[1], m[2] + m[2], m[3] + m[3]].map((x) => parseInt(x, 16));
  else if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(v))) rgb = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(v))) rgb = [m[1], m[2], m[3]].map(Number);
  if (!rgb) return false;
  const max = Math.max(...rgb), min = Math.min(...rgb);
  return max - min < 24 && (max < 90 || min > 225); // unbunt und sehr dunkel oder sehr hell
}

function safeHref(href) {
  const h = String(href || '').trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(h) ? h : '';
}
const DATA_IMG = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function cleanNode(node, out) {
  if (node.type === 'text') { if (!node.raw) out.push({ type: 'text', text: node.text }); return; }
  let tag = node.tag;
  if (DROP.has(tag)) return;
  const a = node.attrs;
  if (tag === 'img') {
    const src = a.src || '';
    if (DATA_IMG.test(src)) out.push({ type: 'el', tag: 'img', attrs: { src: src.replace(/\s+/g, ''), ...(a.alt ? { alt: a.alt.slice(0, 200) } : {}) }, children: [] });
    else if (/^https?:\/\//i.test(src)) out.push({ type: 'el', tag: 'a', attrs: { href: src, rel: 'noopener noreferrer', target: '_blank' }, children: [{ type: 'text', text: `[Bild${a.alt ? ': ' + a.alt.slice(0, 80) : ''}]` }] });
    return;
  }
  const kids = [];
  for (const c of node.children) cleanNode(c, kids);
  if (RENAME[tag]) tag = RENAME[tag];
  if (!KEEP.has(tag)) { out.push(...kids); return; } // unbekannt: Tag weg, Inhalt bleibt
  const attrs = {};
  let style = cleanStyle(a.style);
  if (node.tag === 'font') {
    const extra = [];
    if (a.color && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(a.color) && !isDefaultInk(a.color)) extra.push(`color: ${a.color}`);
    if (FONT_SIZES[a.size]) extra.push(`font-size: ${FONT_SIZES[a.size]}`);
    style = [...extra, style].filter(Boolean).join('; ');
  }
  if (style) attrs.style = style;
  const cls = String(a.class || '').split(/\s+/).filter((c) => CLASSES.has(c));
  if (cls.length) attrs.class = cls.join(' ');
  if (tag === 'a') {
    const href = safeHref(a.href);
    if (!href) { out.push(...kids); return; }
    attrs.href = href; attrs.rel = 'noopener noreferrer'; attrs.target = '_blank';
  }
  if (tag === 'li' && (a['data-checked'] === 'true')) attrs['data-checked'] = 'true';
  if ((tag === 'td' || tag === 'th')) {
    for (const k of ['colspan', 'rowspan']) { const n = parseInt(a[k], 10); if (n > 1 && n <= 20) attrs[k] = String(n); }
  }
  if (tag === 'div' && cls.includes('att')) {
    if (!/^[a-z0-9-]{4,64}$/i.test(a['data-att'] || '')) return; // ungueltige Anhangskarte
    return out.push({ type: 'el', tag: 'div', attrs: { class: 'att', 'data-att': a['data-att'], contenteditable: 'false' }, children: [] });
  }
  out.push({ type: 'el', tag, attrs, children: kids });
}

/** Gibt bereinigtes HTML zurueck (String rein, String raus). */
export function sanitizeHtml(html) {
  const tree = parseHtml(html);
  const out = [];
  for (const c of tree.children) cleanNode(c, out);
  return serialize({ type: 'root', children: out });
}
