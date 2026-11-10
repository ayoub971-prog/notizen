// Die Pflicht-Abfrage beim Einfuegen/Teilen:
// «Möchtest du den Inhalt als Original (bearbeitbar) oder als PDF speichern?»
// - Original: Text/HTML wird bearbeitbar eingefuegt, Bilder inline,
//   andere Dateien als Anhang.
// - PDF: Inhalt wird sofort in ein PDF umgewandelt und als Anhang eingebettet.
import { describeItems, pdfConvertible, parseCsv } from './sharetarget.js';
import { escapeText, escapeAttr } from './htmlparse.js';
import { sanitizeHtml } from './sanitize.js';
import { htmlToBlocks, blocksToText, runsText } from './blocks.js';
import { createPdf, textToBlocks } from './pdf.js';
import { imageToJpeg, jpegifyBlocks } from './media.js';
import { safeFileName } from './exportfmt.js';
import { dialog, infoDialog } from './ui.js';

export function askOriginalOrPdf(items) {
  const onlyUrl = items.length && items.every((i) => i.kind === 'url');
  const text = ['Möchtest du den Inhalt als Original (bearbeitbar) oder als PDF speichern?', describeItems(items)];
  if (onlyUrl) text.push('Hinweis: Bei einem Link wird nur der Link (und mitgeschickter Text) gespeichert – die Webseite selbst lädt die App nicht herunter.');
  return dialog({
    title: 'Inhalt einfügen',
    text,
    className: 'dlg-import',
    buttons: [{ id: 'original', label: 'Original (bearbeitbar)', kind: 'primary' }, { id: 'pdf', label: 'Als PDF' }],
  });
}

const textToHtml = (t) => String(t).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => `<p>${linkify(escapeText(p)).replace(/\n/g, '<br>')}</p>`).join('');
const linkify = (s) => s.replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${escapeAttr(u)}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const csvToHtml = (rows) => {
  const cols = Math.max(...rows.map((r) => r.length));
  return '<table class="note-table"><tbody>' + rows.map((r, i) => '<tr>' + Array.from({ length: cols }, (_, k) => {
    const tag = i === 0 ? 'th' : 'td';
    return `<${tag}>${escapeText(r[k] || '') || '<br>'}</${tag}>`;
  }).join('') + '</tr>').join('') + '</tbody></table><p><br></p>';
};
const firstLine = (t) => String(t).split('\n').map((l) => l.trim()).find(Boolean) || '';
const pdfName = (s, fallback) => safeFileName(firstLine(s).slice(0, 50), fallback) + '.pdf';

/**
 * Fuehrt den Import aus.
 * ctx = { insertHtml(html), addAttachment({ blob, name, type, kind, text, preview }) }
 */
export async function importItems(items, ctx) {
  if (!items.length) return;
  const choice = await askOriginalOrPdf(items);
  if (!choice) return;
  if (choice === 'pdf') items = mergeTextForPdf(items);
  const notConvertible = [];
  // HTML-Teile werden gesammelt und gemeinsam eingefuegt (sonst verschmilzt
  // Chrome aufeinanderfolgende Absaetze zu einer Zeile).
  let pending = '';
  const buffered = {
    insertHtml: (h) => { pending += h; },
    addAttachment: async (a) => { if (pending) { ctx.insertHtml(pending); pending = ''; } return ctx.addAttachment(a); },
  };
  for (const it of items) {
    if (choice === 'original') await insertOriginal(it, buffered);
    else {
      const ok = await insertAsPdf(it, buffered);
      if (!ok) { notConvertible.push(it.file?.name || 'Datei'); await insertOriginal(it, buffered); }
    }
  }
  if (pending) ctx.insertHtml(pending);
  if (notConvertible.length) {
    await infoDialog('Nicht als PDF möglich', [
      `«${notConvertible.join('», «')}» kann diese App ohne Internet nicht in ein PDF umwandeln (z. B. Word-, Excel- oder Videodateien).`,
      'Die Datei wurde deshalb im Original angehängt und bleibt vollständig erhalten.',
      'Tipp: In der Original-App «Drucken → Als PDF speichern» wählen und das PDF hierher teilen.',
    ]);
  }
}

/** Text + Link (typisch beim Teilen einer Webseite) werden zu EINEM PDF zusammengefasst. */
export function mergeTextForPdf(items) {
  const texts = items.filter((i) => i.kind === 'text' || i.kind === 'url');
  if (texts.length < 2 || items.some((i) => i.kind === 'html')) return items;
  const title = texts.find((i) => i.title)?.title || '';
  const text = texts.map((i) => (i.kind === 'url' ? i.url : i.text)).join('\n\n');
  return [{ kind: 'text', text, title }, ...items.filter((i) => i.kind === 'file')];
}

async function insertOriginal(it, ctx) {
  if (it.kind === 'html') return ctx.insertHtml(sanitizeHtml(it.html));
  if (it.kind === 'text') return ctx.insertHtml(textToHtml(it.text));
  if (it.kind === 'url') return ctx.insertHtml(`<p><a href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer">${escapeText(it.title || it.url)}</a></p>`);
  const f = it.file;
  if (it.fileKind === 'image') {
    try { return ctx.insertHtml(`<p><img src="${await imageToJpeg(f)}" alt="${escapeAttr(f.name || 'Bild')}"></p><p><br></p>`); }
    catch { /* nicht lesbar -> als Datei anhaengen */ }
  }
  if (it.fileKind === 'text' && f.size < 2_000_000) return ctx.insertHtml(textToHtml(await f.text()));
  if (it.fileKind === 'csv' && f.size < 2_000_000) { const rows = parseCsv(await f.text()); if (rows.length) return ctx.insertHtml(csvToHtml(rows)); }
  const text = it.fileKind === 'text' || it.fileKind === 'csv' ? (await f.text()).slice(0, 200_000) : '';
  return ctx.addAttachment({ blob: f, name: f.name || 'Datei', type: f.type || 'application/octet-stream', kind: it.fileKind === 'image' ? 'other' : it.fileKind, text });
}

async function insertAsPdf(it, ctx) {
  let blocks, name, text = '', preview = null;
  if (it.kind === 'html') {
    blocks = await jpegifyBlocks(htmlToBlocks(sanitizeHtml(it.html)));
    text = blocksToText(blocks);
    if (it.title) blocks.unshift({ type: 'h1', runs: [{ text: it.title }], indent: 0 });
    name = pdfName(it.title || text, 'Inhalt');
  } else if (it.kind === 'text') {
    blocks = textToBlocks(it.text, it.title);
    text = it.text; name = pdfName(it.title || it.text, 'Text');
  } else if (it.kind === 'url') {
    blocks = [{ type: 'h1', runs: [{ text: it.title || 'Link' }], indent: 0 }, { type: 'p', runs: [{ text: it.url, u: true, color: [0.1, 0.35, 0.8] }], indent: 0 },
      { type: 'p', runs: [{ text: `Gespeichert am ${new Date().toLocaleString('de-CH')}`, i: true, color: [0.4, 0.4, 0.4] }], indent: 0 }];
    text = `${it.title || ''} ${it.url}`; name = pdfName(it.title || 'Link', 'Link');
  } else {
    const f = it.file;
    if (!pdfConvertible(it.fileKind)) return false;
    if (it.fileKind === 'pdf') { await ctx.addAttachment({ blob: f, name: f.name || 'Dokument.pdf', type: 'application/pdf', kind: 'pdf', text: '' }); return true; }
    const stem = safeFileName((f.name || 'Datei').replace(/\.[^.]+$/, ''), 'Datei');
    if (it.fileKind === 'image') {
      let src;
      try { src = await imageToJpeg(f, { max: 2400, quality: 0.9 }); } catch { return false; }
      preview = await imageToJpeg(f, { max: 320, quality: 0.7 }).catch(() => null);
      blocks = [{ type: 'img', src }];
      text = f.name || ''; name = stem + '.pdf';
    } else if (it.fileKind === 'csv') {
      const raw = await f.text();
      const rows = parseCsv(raw);
      blocks = [{ type: 'h1', runs: [{ text: stem }], indent: 0 }, { type: 'table', rows: rows.map((r, i) => ({ header: i === 0, cells: r.map((c) => [{ text: c }]) })) }];
      text = raw.slice(0, 200_000); name = stem + '.pdf';
    } else {
      const raw = await f.text();
      blocks = textToBlocks(raw, stem); text = raw.slice(0, 200_000); name = stem + '.pdf';
    }
  }
  const bytes = createPdf({ title: name.replace(/\.pdf$/, ''), blocks });
  await ctx.addAttachment({ blob: new Blob([bytes], { type: 'application/pdf' }), name, type: 'application/pdf', kind: 'pdf', text, preview, fromApp: true });
  return true;
}

export { runsText };
