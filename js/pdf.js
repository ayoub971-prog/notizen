// Eigener, kleiner PDF-Generator (keine fremden Bibliotheken).
// - Seiten A4, Schrift Helvetica (in jedem PDF-Leser eingebaut, daher nicht eingebettet)
// - Umlaute/Sonderzeichen ueber WinAnsi-Kodierung (ä ö ü é € « » – … usw.)
// - Ueberschriften, fett/kursiv/unterstrichen, Farben, Groessen
// - Listen und Checklisten, Tabellen mit festen Linien (Kopfzeile wird auf
//   neuen Seiten wiederholt), JPEG-Bilder, Seitenzahlen
// Eingabe: Bloecke aus blocks.js. Ausgabe: Uint8Array mit der PDF-Datei.
import { WIDTHS } from './pdf-metrics.js';

const PAGE_W = 595.28, PAGE_H = 841.89;
const M_LEFT = 56, M_RIGHT = 56, M_TOP = 60, M_BOTTOM = 64;
const CONTENT_W = PAGE_W - M_LEFT - M_RIGHT;
const SIZES = { p: 11, li: 11, quote: 11, pre: 9.5, h1: 20, h2: 15, h3: 12.5 };

// Unicode -> WinAnsi (Windows-1252) fuer die Zeichen 0x80-0x9F
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const EXTRA = { 0x2212: '-', 0x2010: '-', 0x2011: '-', 0x00a0: ' ', 0x2009: ' ', 0x202f: ' ', 0x2002: ' ', 0x2003: ' ', 0x2192: '->', 0x2190: '<-',
  0x2713: 'v', 0x2714: 'v', 0x2610: '[ ]', 0x2611: '[x]', 0x2612: '[x]', 0x25cf: '•', 0x25aa: '•', 0x2264: '<=', 0x2265: '>=', 0x2260: '!=' };

/** Text -> Byte-Array in WinAnsi. Nicht darstellbare Zeichen werden vereinfacht oder zu '?'. */
export function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c === 9) { out.push(32, 32, 32, 32); continue; }
    if (c >= 32 && c < 127) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (CP1252[c]) out.push(CP1252[c]);
    else if (EXTRA[c]) for (const x of EXTRA[c]) out.push(x.charCodeAt(0) < 256 ? x.charCodeAt(0) : 63);
    else if (c < 32 || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x200b || c === 0x200d) continue; // Steuerzeichen, Emoji-Varianten
    else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const b = base.codePointAt(0);
      out.push(base.length === 1 && b < 256 && b >= 32 ? b : 63);
    }
  }
  return out;
}

function fontKey(r, pre) { if (pre) return 'F5'; return r.b && r.i ? 'F4' : r.b ? 'F2' : r.i ? 'F3' : 'F1'; }
export function textWidth(bytes, font, size) {
  if (font === 'F5') return bytes.length * 0.6 * size;
  const table = font === 'F2' || font === 'F4' ? WIDTHS.bold : WIDTHS.regular;
  let w = 0;
  for (const b of bytes) w += table[b - 32] ?? 556;
  return (w * size) / 1000;
}

function pdfString(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}
const num = (n) => (Math.round(n * 100) / 100).toString();
const colorOps = (c, stroke) => (c ? `${num(c[0])} ${num(c[1])} ${num(c[2])} ${stroke ? 'RG' : 'rg'}` : stroke ? '0 0 0 RG' : '0 0 0 rg');

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Liest Breite, Hoehe und Farbkanaele aus einer JPEG-Datei (oder null). */
export function jpegInfo(bytes) {
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// ---------- Zeilenumbruch ----------
// Zerlegt Runs in Zeilen. Rueckgabe: [{ segs: [{bytes, font, size, color, u, s, w}], w, h }]
function layoutRuns(runs, maxW, opts = {}) {
  const lines = [];
  let line = { segs: [], w: 0, h: 0 };
  const firstW = maxW, nextW = maxW - (opts.hang || 0);
  const limit = () => (lines.length === 0 ? firstW : nextW);
  const pushLine = () => {
    while (line.segs.length && line.segs[line.segs.length - 1].space) { line.w -= line.segs.pop().w; }
    if (!line.h) line.h = (opts.size || 11) * 1.3;
    lines.push(line); line = { segs: [], w: 0, h: 0 };
  };
  const add = (bytes, r, space) => {
    const font = fontKey(r, opts.pre);
    const size = r.size || opts.size || 11;
    const w = textWidth(bytes, font, size);
    line.segs.push({ bytes, font, size, color: r.color, u: r.u, s: r.s, w, space });
    line.w += w; line.h = Math.max(line.h, size * 1.3);
  };
  for (const r0 of runs) {
    const r = opts.bold ? { ...r0, b: true } : r0;
    const parts = String(r.text).split(/(\n| +)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') { pushLine(); continue; }
      const bytes = toWinAnsi(part);
      if (!bytes.length) continue;
      const font = fontKey(r, opts.pre), size = r.size || opts.size || 11;
      const w = textWidth(bytes, font, size);
      if (part[0] === ' ') { if (line.segs.length) add(bytes, r, true); continue; }
      if (line.w + w > limit() && line.segs.length) pushLine();
      if (w > limit()) { // sehr langes Wort: zeichenweise trennen
        let chunk = [];
        for (const b of bytes) {
          if (textWidth([...chunk, b], font, size) + line.w > limit() && (chunk.length || line.segs.length)) {
            if (chunk.length) add(chunk, r, false);
            pushLine(); chunk = [];
          }
          chunk.push(b);
        }
        if (chunk.length) add(chunk, r, false);
      } else add(bytes, r, false);
    }
  }
  if (line.segs.length || !lines.length) pushLine();
  return lines;
}

// ---------- Seitenaufbau ----------
class Writer {
  constructor() { this.pages = []; this.images = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = PAGE_H - M_TOP; }
  ensure(h) { if (this.y - h < M_BOTTOM && this.y < PAGE_H - M_TOP - 1) this.newPage(); }
  drawLine(line, x) {
    const base = this.y - line.h * 0.78;
    let cx = x;
    for (const s of line.segs) {
      if (!s.space) {
        this.ops.push(`BT /${s.font} ${num(s.size)} Tf ${colorOps(s.color)} ${num(cx)} ${num(base)} Td ${pdfString(s.bytes)} Tj ET`);
        if (s.u) this.ops.push(`${colorOps(s.color, true)} ${num(s.size * 0.06)} w ${num(cx)} ${num(base - s.size * 0.12)} m ${num(cx + s.w)} ${num(base - s.size * 0.12)} l S`);
        if (s.s) this.ops.push(`${colorOps(s.color, true)} ${num(s.size * 0.06)} w ${num(cx)} ${num(base + s.size * 0.3)} m ${num(cx + s.w)} ${num(base + s.size * 0.3)} l S`);
      }
      cx += s.w;
    }
    this.y -= line.h;
  }
}

function drawCheckbox(wr, x, line, checked) {
  const s = 8.5, base = wr.y - line.h * 0.78;
  wr.ops.push(`0.4 0.4 0.4 RG 0.8 w ${num(x)} ${num(base - 0.5)} ${s} ${s} re S`);
  if (checked) wr.ops.push(`0.85 0.6 0 RG 1.4 w ${num(x + 1.8)} ${num(base + 3.8)} m ${num(x + 3.6)} ${num(base + 1.5)} l ${num(x + 7.2)} ${num(base + 7)} l S`);
}

function tableLayout(block, wr) {
  const cols = Math.max(...block.rows.map((r) => r.cells.length));
  const pad = 4, size = 10;
  const natural = Array(cols).fill(30);
  for (const r of block.rows) r.cells.forEach((c, k) => {
    const longest = Math.max(0, ...c.map((x) => x.text).join('').split('\n').map((t) => textWidth(toWinAnsi(t), r.header ? 'F2' : 'F1', size)));
    natural[k] = Math.max(natural[k], Math.min(longest, 260) + 2 * pad);
  });
  const sum = natural.reduce((a, b) => a + b, 0);
  let widths = natural.map((n) => (n / sum) * CONTENT_W);
  const minW = Math.min(40, CONTENT_W / cols);
  widths = widths.map((w) => Math.max(minW, w));
  const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => w * scale);
  const layoutRow = (r) => {
    const cells = Array.from({ length: cols }, (_, k) => layoutRuns(r.cells[k] || [], widths[k] - 2 * pad, { size, bold: r.header }));
    const h = Math.max(...cells.map((ls) => ls.reduce((a, l) => a + l.h, 0))) + 2 * pad;
    return { cells, h, header: r.header };
  };
  const rows = block.rows.map(layoutRow);
  const header = rows[0].header ? rows[0] : null;
  const drawRow = (row) => {
    let x = M_LEFT;
    const top = wr.y;
    if (row.header) wr.ops.push(`0.93 0.93 0.93 rg ${num(M_LEFT)} ${num(top - row.h)} ${num(CONTENT_W)} ${num(row.h)} re f`);
    row.cells.forEach((lines, k) => {
      wr.y = top - pad;
      for (const l of lines) wr.drawLine(l, x + pad);
      wr.ops.push(`0.35 0.35 0.35 RG 0.6 w ${num(x)} ${num(top - row.h)} ${num(widths[k])} ${num(row.h)} re S`);
      x += widths[k];
    });
    wr.y = top - row.h;
  };
  rows.forEach((row, idx) => {
    if (wr.y - row.h < M_BOTTOM && wr.y < PAGE_H - M_TOP - 1) {
      wr.newPage();
      if (header && idx > 0) drawRow(header); // Kopfzeile wiederholen
    }
    drawRow(row);
  });
  wr.y -= 8;
}

/**
 * Erstellt ein PDF.
 * @param {object} o
 * @param {string} o.title  Dokumenttitel (Metadaten)
 * @param {Array}  o.blocks Bloecke aus htmlToBlocks()
 * @param {(id:string)=>string} [o.attName] Name eines Anhangs fuer Platzhalter
 * @param {Date}   [o.date]
 * @returns {Uint8Array}
 */
export function createPdf({ title = 'Notiz', blocks = [], attName = () => 'Anhang', date = new Date() }) {
  const wr = new Writer();
  // Wichtig: die uebergebenen Bloecke werden NICHT veraendert (nur lokale Kopien).
  for (const original of blocks) {
    let b = original;
    if (b.type === 'hr') {
      wr.ensure(14); wr.y -= 7;
      wr.ops.push(`0.7 0.7 0.7 RG 0.6 w ${num(M_LEFT)} ${num(wr.y)} m ${num(PAGE_W - M_RIGHT)} ${num(wr.y)} l S`);
      wr.y -= 7; continue;
    }
    if (b.type === 'table') { tableLayout(b, wr); continue; }
    if (b.type === 'img') {
      const m = /^data:image\/jpe?g;base64,(.*)$/i.exec(b.src || '');
      const bytes = m ? base64ToBytes(m[1]) : null;
      const info = bytes && jpegInfo(bytes);
      if (!info) b = { type: 'p', runs: [{ text: '[Bild]', i: true }], indent: 0 };
      else {
        let w = Math.min(CONTENT_W, info.width * 0.75), h = (w * info.height) / info.width;
        const maxH = PAGE_H - M_TOP - M_BOTTOM;
        if (h > maxH) { w = (w * maxH) / h; h = maxH; }
        wr.ensure(h + 6);
        const name = `Im${wr.images.length + 1}`;
        wr.images.push({ name, bytes, info });
        wr.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(M_LEFT)} ${num(wr.y - h)} cm /${name} Do Q`);
        wr.y -= h + 8;
        continue;
      }
    }
    if (b.type === 'att') b = { type: 'p', runs: [{ text: 'Anhang: ' + attName(b.id), i: true, color: [0.35, 0.35, 0.35] }], indent: 0 };
    const size = SIZES[b.type] || 11;
    const heading = /^h[123]$/.test(b.type);
    const indent = (b.indent || 0) * 16;
    let x = M_LEFT + indent;
    let hang = 0;
    let runs = b.runs;
    const isCheck = b.prefix && b.checked !== undefined;
    if (b.prefix && !isCheck) {
      runs = [{ text: b.prefix.replace(/ $/, '\u00a0') }, ...runs];
      hang = textWidth(toWinAnsi(b.prefix), 'F1', size);
    }
    if (isCheck) { x += 14; }
    const lines = layoutRuns(runs, CONTENT_W - indent - (isCheck ? 14 : 0), { size, bold: heading, pre: b.type === 'pre', hang });
    const before = b.type === 'h1' ? 10 : heading ? 8 : 0;
    const after = heading ? 4 : b.type === 'li' ? 2.5 : 6;
    wr.ensure(before + lines[0].h);
    if (wr.y < PAGE_H - M_TOP - 1) wr.y -= before;
    if (b.type === 'quote') wr.ops.push(`0.8 0.8 0.8 rg ${num(M_LEFT - 8)} ${num(wr.y - lines.reduce((a, l) => a + l.h, 0))} 2.5 ${num(lines.reduce((a, l) => a + l.h, 0))} re f`);
    lines.forEach((l, k) => {
      wr.ensure(l.h);
      if (k === 0 && isCheck) drawCheckbox(wr, x - 14, l, b.checked);
      wr.drawLine(l, x + (k > 0 ? hang : 0));
    });
    if (b.type === 'h1') wr.ops.push(`0.85 0.65 0.1 RG 1 w ${num(M_LEFT)} ${num(wr.y - 2)} m ${num(M_LEFT + 60)} ${num(wr.y - 2)} l S`);
    wr.y -= after;
  }
  return assemble(wr, title, date);
}

function utf16Hex(s) {
  let h = '<FEFF';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return h + '>';
}
function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}

function assemble(wr, title, date) {
  const enc = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };
  const chunks = [];
  let length = 0;
  const offsets = [];
  const write = (x) => { const b = typeof x === 'string' ? enc(x) : x; chunks.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; write(`${n} 0 obj\n`); for (const part of [].concat(body)) write(part); write('\nendobj\n'); };

  const total = wr.pages.length;
  const fonts = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Helvetica-Oblique', F4: 'Helvetica-BoldOblique', F5: 'Courier' };
  // Objektnummern: 1 Katalog, 2 Seitenbaum, 3-7 Schriften, dann Bilder, dann Seiten (+Inhalt), zuletzt Info
  const imgBase = 8;
  const pageBase = imgBase + wr.images.length;
  const infoNum = pageBase + total * 2;

  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: total }, (_, k) => `${pageBase + k * 2} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
  Object.entries(fonts).forEach(([k, name], idx) => obj(3 + idx, `<< /Type /Font /Subtype /Type1 /BaseFont /${name}${name === 'Courier' ? '' : ' /Encoding /WinAnsiEncoding'} >>`));
  wr.images.forEach((im, k) => {
    const cs = im.info.components === 1 ? '/DeviceGray' : im.info.components === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
    obj(imgBase + k, [`<< /Type /XObject /Subtype /Image /Width ${im.info.width} /Height ${im.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
  });
  const fontRes = Object.keys(fonts).map((k, idx) => `/${k} ${3 + idx} 0 R`).join(' ');
  const xobjRes = wr.images.length ? ` /XObject << ${wr.images.map((im, k) => `/${im.name} ${imgBase + k} 0 R`).join(' ')} >>` : '';
  wr.pages.forEach((ops, k) => {
    const footer = total > 1 ? [`BT /F1 8 Tf 0.5 0.5 0.5 rg ${num(PAGE_W / 2 - 22)} 30 Td ${pdfString(toWinAnsi(`Seite ${k + 1} von ${total}`))} Tj ET`] : [];
    const content = [...ops, ...footer].join('\n');
    const pn = pageBase + k * 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] /Resources << /Font << ${fontRes} >>${xobjRes} >> /Contents ${pn + 1} 0 R >>`);
    obj(pn + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
  });
  obj(infoNum, `<< /Title ${utf16Hex(String(title).slice(0, 200))} /Producer (Notizen) /CreationDate ${pdfDate(date)} >>`);
  const xref = length;
  let x = `xref\n0 ${infoNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= infoNum; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  write(x);
  write(`trailer\n<< /Size ${infoNum + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Einfacher Text -> PDF (z. B. fuer eingefuegten Text oder .txt-Dateien). */
export function textToBlocks(text, title) {
  const blocks = [];
  if (title) blocks.push({ type: 'h1', runs: [{ text: title }], indent: 0 });
  for (const para of String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    if (para.trim()) blocks.push({ type: 'p', runs: [{ text: para }], indent: 0 });
  }
  return blocks;
}
