// Wandelt Notiz-HTML in eine einfache Liste von "Bloecken" um.
// Diese Bloecke sind die gemeinsame Grundlage fuer
//   - den PDF-Export (pdf.js)
//   - den Text-Export (.txt) und den Suchtext
// Block-Typen:
//   { type: 'p'|'h1'|'h2'|'h3'|'li'|'pre'|'quote', runs: [Run], prefix?: '• ', indent: 0 }
//   { type: 'table', rows: [{ header: bool, cells: [[Run]] }] }
//   { type: 'img', src: 'data:image/jpeg;base64,...' }
//   { type: 'hr' }   { type: 'att', id: 'Anhang-ID' }
// Run = { text, b, i, u, s, color: [r,g,b] (0..1) | null, size: Punkt | null }
import { parseHtml } from './htmlparse.js';

const NAMED = { black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 0.5, 0], blue: [0, 0, 1], gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], orange: [1, 0.65, 0], purple: [0.5, 0, 0.5], yellow: [1, 1, 0], brown: [0.65, 0.16, 0.16] };

export function parseColor(v) {
  v = String(v || '').trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3})$/.exec(v))) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v))) return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255);
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(v))) return [m[1], m[2], m[3]].map((x) => Math.min(255, +x) / 255);
  return NAMED[v] || null;
}

function parseStyle(style) {
  const o = {};
  for (const d of String(style || '').split(';')) {
    const k = d.indexOf(':');
    if (k > 0) o[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim().toLowerCase();
  }
  return o;
}

/** Schriftgroesse in PDF-Punkten aus CSS-Wert (16px Standard = 11pt). */
function sizeToPt(v, current) {
  let m;
  if ((m = /^([\d.]+)px$/.exec(v))) return +m[1] * 0.6875;
  if ((m = /^([\d.]+)pt$/.exec(v))) return +m[1] * 0.92;
  if ((m = /^([\d.]+)(em|rem)$/.exec(v))) return +m[1] * 11;
  if ((m = /^([\d.]+)%$/.exec(v))) return (+m[1] / 100) * (current || 11);
  return { 'x-small': 8, small: 9.5, medium: 11, large: 13, 'x-large': 16, 'xx-large': 20 }[v] || null;
}

function styleFor(node, st) {
  const n = { ...st };
  const t = node.tag;
  if (t === 'b' || t === 'strong' || t === 'th') n.b = true;
  if (t === 'i' || t === 'em') n.i = true;
  if (t === 'u') n.u = true;
  if (t === 's' || t === 'strike') n.s = true;
  const css = parseStyle(node.attrs.style);
  if (css['font-weight']) n.b = /bold|[6-9]00/.test(css['font-weight']);
  if (css['font-style']) n.i = /italic|oblique/.test(css['font-style']);
  const deco = css['text-decoration-line'] || css['text-decoration'];
  if (deco) { if (deco.includes('underline')) n.u = true; if (deco.includes('line-through')) n.s = true; }
  if (css.color) n.color = parseColor(css.color) || n.color;
  if (css['font-size']) n.size = sizeToPt(css['font-size'], n.size) || n.size;
  return n;
}

const BLOCK_TAGS = { p: 'p', div: 'p', h1: 'h1', h2: 'h2', h3: 'h3', pre: 'pre', blockquote: 'quote' };

export function htmlToBlocks(html) {
  const tree = typeof html === 'string' ? parseHtml(html) : html;
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.runs.some((r) => r.text.replace(/\n/g, '').trim()) || cur.prefix)) {
      while (cur.runs.length && /^\n+$/.test(cur.runs[cur.runs.length - 1].text)) cur.runs.pop();
      blocks.push(cur);
    }
    cur = null;
  };
  const ensure = (type = 'p', extra = {}) => { if (!cur) cur = { type, runs: [], indent: 0, ...extra }; return cur; };
  const listStack = [];

  function inline(node, st) {
    if (node.type === 'text') {
      if (node.raw) return;
      let text = node.text;
      if (!(cur && cur.type === 'pre')) text = text.replace(/[ \t\r\n]+/g, ' ');
      if (!cur && !text.trim()) return;
      ensure().runs.push({ text, b: !!st.b, i: !!st.i, u: !!st.u, s: !!st.s, color: st.color || null, size: st.size || null });
      return;
    }
    walk(node, st);
  }

  function cellRuns(node, st) {
    // Tabellenzelle: Inhalt als eine Folge von Runs (Zeilenumbrueche als \n)
    const saved = cur; cur = { type: 'p', runs: [], indent: 0 };
    const sub = (n, s) => {
      if (n.type === 'text') return inline(n, s);
      if (n.tag === 'br') { cur.runs.push({ text: '\n', ...s }); return; }
      const s2 = styleFor(n, s);
      if ((BLOCK_TAGS[n.tag] || n.tag === 'li') && cur.runs.length) cur.runs.push({ text: '\n', ...s2 });
      if (n.tag === 'li') cur.runs.push({ text: '• ', ...s2 });
      n.children.forEach((c) => sub(c, s2));
    };
    node.children.forEach((c) => sub(c, st));
    const runs = cur.runs.map((r) => ({ text: r.text, b: !!r.b, i: !!r.i, u: !!r.u, s: !!r.s, color: r.color || null, size: r.size || null }));
    cur = saved;
    return runs;
  }

  function walk(node, st) {
    if (node.type === 'text') return inline(node, st);
    const t = node.tag;
    if (t === 'br') { ensure().runs.push({ text: '\n', b: false, i: false, u: false, s: false, color: null, size: null }); return; }
    if (t === 'hr') { flush(); blocks.push({ type: 'hr' }); return; }
    if (t === 'img') {
      flush();
      if (/^data:image\//.test(node.attrs.src || '')) blocks.push({ type: 'img', src: node.attrs.src });
      return;
    }
    if (t === 'div' && /\batt\b/.test(node.attrs.class || '')) { flush(); blocks.push({ type: 'att', id: node.attrs['data-att'] }); return; }
    if (t === 'table') {
      flush();
      const rows = [];
      const collect = (n) => {
        for (const c of n.children) {
          if (c.type !== 'el') continue;
          if (c.tag === 'tr') {
            const cells = c.children.filter((x) => x.type === 'el' && (x.tag === 'td' || x.tag === 'th'));
            if (!cells.length) continue;
            const header = cells.every((x) => x.tag === 'th') || n.tag === 'thead';
            rows.push({ header, cells: cells.map((x) => cellRuns(x, styleFor(x, st))) });
          } else if (['thead', 'tbody', 'tfoot'].includes(c.tag)) collect(c);
        }
      };
      collect(node);
      if (rows.length) blocks.push({ type: 'table', rows });
      return;
    }
    if (t === 'ul' || t === 'ol') {
      flush();
      listStack.push({ ordered: t === 'ol', check: /\bchecklist\b/.test(node.attrs.class || ''), n: 0 });
      for (const c of node.children) {
        if (c.type === 'el' && c.tag === 'li') walk(c, st);
        else if (c.type === 'el') walk(c, st);
      }
      flush();
      listStack.pop();
      return;
    }
    if (t === 'li') {
      flush();
      const L = listStack[listStack.length - 1] || { ordered: false, check: false, n: 0 };
      L.n++;
      const prefix = L.check ? (node.attrs['data-checked'] === 'true' ? '[x] ' : '[ ] ') : L.ordered ? `${L.n}. ` : '• ';
      cur = { type: 'li', runs: [], indent: Math.max(0, listStack.length - 1), prefix, checked: L.check ? node.attrs['data-checked'] === 'true' : undefined };
      const s2 = styleFor(node, st);
      for (const c of node.children) walk(c, s2);
      flush();
      return;
    }
    const bt = BLOCK_TAGS[t];
    if (bt) {
      const inLi = cur && cur.type === 'li';
      if (!inLi) { flush(); cur = { type: bt, runs: [], indent: 0 }; }
      else if (cur.runs.length) cur.runs.push({ text: '\n', b: false, i: false, u: false, s: false, color: null, size: null });
      const s2 = styleFor(node, st);
      for (const c of node.children) walk(c, s2);
      if (!inLi) flush();
      return;
    }
    const s2 = styleFor(node, st);
    for (const c of node.children) walk(c, s2);
  }
  for (const c of tree.children) walk(c, {});
  flush();
  // Leerzeichen am Zeilenanfang/-ende entfernen
  for (const b of blocks) {
    if (!b.runs || b.type === 'pre') continue;
    if (b.runs.length) { b.runs[0].text = b.runs[0].text.replace(/^ +/, ''); const l = b.runs[b.runs.length - 1]; l.text = l.text.replace(/ +$/, ''); }
  }
  return blocks;
}

export const runsText = (runs) => runs.map((r) => r.text).join('');

/** Reiner Text, z. B. fuer .txt-Export, Suche und Teilen als Text.
 *  Tabellen werden mit festen Spaltenbreiten und | ausgerichtet. */
export function blocksToText(blocks, attName = (id) => `[Anhang]`) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'table') {
      const rows = b.rows.map((r) => r.cells.map((c) => runsText(c).replace(/\s*\n\s*/g, ' / ').trim()));
      const cols = Math.max(...rows.map((r) => r.length));
      const w = Array.from({ length: cols }, (_, k) => Math.min(40, Math.max(3, ...rows.map((r) => (r[k] || '').length))));
      rows.forEach((r, ri) => {
        out.push('| ' + w.map((ww, k) => (r[k] || '').padEnd(ww)).join(' | ') + ' |');
        if (ri === 0 && b.rows[0].header) out.push('|-' + w.map((ww) => '-'.repeat(ww)).join('-|-') + '-|');
      });
      out.push('');
    } else if (b.type === 'hr') out.push('----------');
    else if (b.type === 'img') out.push('[Bild]');
    else if (b.type === 'att') out.push(attName(b.id));
    else {
      const text = runsText(b.runs);
      const pad = '  '.repeat(b.indent || 0);
      if (b.type === 'h1' || b.type === 'h2') out.push(text);
      else out.push(pad + (b.prefix || '') + text.replace(/\n/g, '\n' + pad + (b.prefix ? '  ' : '')));
      if (b.type === 'h1') out.push('='.repeat(Math.min(40, text.length)));
      if (b.type === 'h2') out.push('-'.repeat(Math.min(40, text.length)));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
