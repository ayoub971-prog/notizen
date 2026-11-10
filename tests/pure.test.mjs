// Unit-Tests fuer die reinen Module. Start: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeHtml, cleanStyle, isDefaultInk } from '../js/sanitize.js';
import { parseHtml, serialize } from '../js/htmlparse.js';
import { htmlToBlocks, blocksToText } from '../js/blocks.js';
import { createPdf, toWinAnsi, jpegInfo, textToBlocks } from '../js/pdf.js';
import { makeZip, readZip, crc32 } from '../js/zip.js';
import { buildIndex, search, normalize, snippet, findMatches } from '../js/search.js';
import { flattenTree, pathOf, descendantIds, canMoveFolder, moveFolder, planDeleteFolder, validateFolderName } from '../js/tree.js';
import { parseShared, classifyFile, describeItems, parseCsv, pdfConvertible, isHeic } from '../js/sharetarget.js';
import { safeFileName, assignFileNames, assignAttachmentNames, linkAttachments, standaloneHtml } from '../js/exportfmt.js';
import { planLayout, noteOutputs, TRASH_DIR, readBackupZip } from '../js/backup.js';
import { mergeTextForPdf } from '../js/importer.js';

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notizen-test-'));

// ---------- Sanitizer ----------
test('sanitizer entfernt Skripte, Ereignisse, gefaehrliche Links und externe Bilder', () => {
  const dirty = `<p onclick="alert(1)">Hallo<script>alert(2)</script><style>p{}</style></p>
    <a href="javascript:alert(3)">x</a><a href="https://ex.ch/a" onmouseover="y()">ok</a>
    <img src="https://tracker.example/p.gif" onerror="z()"><img src="data:image/png;base64,iVBORw0KGgo=">
    <iframe src="https://evil"></iframe><svg><script>1</script></svg><form><input value="x"></form>
    <span style="color: red; position: fixed; background-image: url(https://x)">rot</span>`;
  const out = sanitizeHtml(dirty);
  assert.doesNotMatch(out, /script|onclick|onerror|onmouseover|javascript:|iframe|svg|<form|<input|position|url\(|<style/i);
  assert.match(out, /<a href="https:\/\/ex\.ch\/a" rel="noopener noreferrer" target="_blank">ok<\/a>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.match(out, /\[Bild\]/); // externes Bild nur als Link
  assert.match(out, /<span style="color: red">rot<\/span>/);
  assert.doesNotMatch(out, /src="https/);
});

test('sanitizer behaelt Notiz-Strukturen (Checkliste, Tabelle, Anhang) und wandelt font um', () => {
  const html = '<ul class="checklist evil"><li data-checked="true" onclick="x">Milch</li></ul><table class="note-table"><tr><th colspan="2">A</th></tr><tr><td>1</td><td>2</td></tr></table><div class="att" data-att="a-123-abcd" onload="x">Anhang</div><font color="#d93025" size="5">gross</font><h5>klein</h5>';
  const out = sanitizeHtml(html);
  assert.match(out, /<ul class="checklist"><li data-checked="true">Milch<\/li><\/ul>/);
  assert.match(out, /<th colspan="2">A<\/th>/);
  assert.match(out, /<div class="att" data-att="a-123-abcd" contenteditable="false"><\/div>/);
  assert.match(out, /<span style="color: #d93025; font-size: 24px">gross<\/span>/);
  assert.match(out, /<h3>klein<\/h3>/);
  assert.equal(sanitizeHtml('<div class="att" data-att="../../x">y</div>'), '');
});

test('sanitizer: Standardfarben (schwarz/weiss) werden entfernt, bunte bleiben', () => {
  assert.equal(isDefaultInk('rgb(0, 0, 0)'), true);
  assert.equal(isDefaultInk('#333'), true);
  assert.equal(isDefaultInk('#ffffff'), true);
  assert.equal(isDefaultInk('#1a73e8'), false);
  assert.equal(cleanStyle('color: #000; font-weight: bold'), 'font-weight: bold');
});

test('HTML-Parser: Entities, ungeschlossene Tags, Kommentare', () => {
  const t = parseHtml('<p>a &amp; b &auml; &#228; &#x20AC;<!-- c --><li>x<li>y</p>');
  assert.equal(serialize(t), '<p>a &amp; b ä ä €<li>x</li><li>y</li></p>');
});

// ---------- Bloecke / Text ----------
const SAMPLE = `<h1>Bestellung Müller</h1><p>Hallo <b>fett</b> und <span style="color: #ff0000">rot</span>, Grüsse aus Zürich – «Test» €</p>
<ul class="checklist"><li data-checked="true">Milch</li><li>Brot</li></ul><ol><li>eins</li><li>zwei</li></ol>
<table class="note-table"><tr><th>Artikel</th><th>Menge</th></tr><tr><td>Äpfel</td><td>12</td></tr><tr><td>Öl</td><td>3</td></tr></table>`;

test('Bloecke: Ueberschrift, Stile, Listen, Tabelle', () => {
  const b = htmlToBlocks(SAMPLE);
  assert.equal(b[0].type, 'h1');
  assert.ok(b[1].runs.some((r) => r.text === 'fett' && r.b));
  assert.deepEqual(b[1].runs.find((r) => r.text === 'rot').color, [1, 0, 0]);
  assert.equal(b[2].prefix, '[x] ');
  assert.equal(b[5].prefix, '2. ');
  const table = b.find((x) => x.type === 'table');
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0].header, true);
  const txt = blocksToText(b);
  assert.match(txt, /\| Artikel \| Menge \|/);
  assert.match(txt, /\| Äpfel   \| 12    \|/);
  assert.match(txt, /\[x\] Milch/);
});

// ---------- PDF ----------
test('WinAnsi-Kodierung fuer Umlaute und Sonderzeichen', () => {
  assert.deepEqual(toWinAnsi('äöüÄÖÜéß'), [0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xe9, 0xdf]);
  assert.deepEqual(toWinAnsi('€–«»…'), [0x80, 0x96, 0xab, 0xbb, 0x85]);
  assert.deepEqual(toWinAnsi('ăő'), [0x61, 0x6f]); // Akzent entfernt
  assert.deepEqual(toWinAnsi('ł😀'), [63, 63]); // nicht darstellbar -> ?
});

function checkPdfStructure(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const startxref = +/startxref\n(\d+)/.exec(s)[1];
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const m = /xref\n0 (\d+)\n/.exec(s.slice(startxref));
  const count = +m[1];
  const lines = s.slice(startxref).split('\n').slice(2, 2 + count);
  lines.slice(1).forEach((l, i) => {
    const off = +l.slice(0, 10);
    assert.ok(s.startsWith(`${i + 1} 0 obj`, off), `Objekt ${i + 1} am Offset ${off}`);
  });
  // Stream-Laengen pruefen
  for (const mm of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = mm.index + mm[0].length;
    assert.equal(s.slice(start + +mm[1], start + +mm[1] + 10), '\nendstream');
  }
  return s;
}

// Kleinstes gueltiges JPEG (8x8 grau), erzeugt mit Pillow und hier eingebettet
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==';

test('PDF: gueltige Struktur, Umlaute, Tabelle ueber mehrere Seiten, Bild', () => {
  let rows = '';
  for (let i = 0; i < 80; i++) rows += `<tr><td>Artikel ${i} Gemüse</td><td>${i}</td></tr>`;
  const blocks = htmlToBlocks(SAMPLE + `<table><tr><th>Lager</th><th>Bestand</th></tr>${rows}</table><p><img src="data:image/jpeg;base64,${JPEG_B64}"></p>`);
  assert.deepEqual(jpegInfo(Buffer.from(JPEG_B64, 'base64')), { width: 8, height: 8, components: 1 });
  const pdf = createPdf({ title: 'Bestellung Müller', blocks });
  const s = checkPdfStructure(pdf);
  assert.match(s, /\/Encoding \/WinAnsiEncoding/);
  assert.match(s, /\/Filter \/DCTDecode/);
  assert.match(s, / re S/); // Tabellenlinien
  const file = path.join(tmp, 'test.pdf');
  fs.writeFileSync(file, pdf);
  if (has('pdfinfo') && has('pdftotext')) {
    const info = execFileSync('pdfinfo', [file]).toString();
    assert.match(info, /Pages:\s+[2-9]/);
    assert.match(info, /Title:\s+Bestellung Müller/);
    const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
    assert.match(text, /Bestellung Müller/);
    assert.match(text, /Grüsse aus Zürich – «Test» €/);
    assert.match(text, /Äpfel\s+12/);
    assert.match(text, /Artikel 79 Gemüse\s+79/);
    assert.match(text, /Seite 2 von/);
    // Kopfzeile wird auf Folgeseite wiederholt
    assert.ok((text.match(/Lager\s+Bestand/g) || []).length >= 2);
  }
});

test('PDF aus reinem Text mit langen Woertern', () => {
  const pdf = createPdf({ title: 'Text', blocks: textToBlocks('Ein ' + 'x'.repeat(400) + '\n\nZweiter Absatz äöü', 'Titel') });
  checkPdfStructure(pdf);
  if (has('pdftotext')) {
    const f = path.join(tmp, 't2.pdf'); fs.writeFileSync(f, pdf);
    assert.match(execFileSync('pdftotext', [f, '-']).toString(), /Zweiter Absatz äöü/);
  }
});

// ---------- ZIP ----------
test('ZIP: CRC32, Rundlauf und Pruefung mit unzip/python', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const entries = [
    { name: 'Notizen/Einkauf/Bestellung Müller.txt', data: 'Grüezi\nÄpfel 12' },
    { name: 'Notizen/Einkauf/Bild.bin', data: new Uint8Array([0, 1, 2, 255]) },
    { name: 'LIESMICH.txt', data: '' },
  ];
  const zip = makeZip(entries);
  const back = await readZip(zip);
  assert.equal(back.length, 3);
  assert.equal(new TextDecoder().decode(back[0].data), 'Grüezi\nÄpfel 12');
  assert.deepEqual([...back[1].data], [0, 1, 2, 255]);
  const file = path.join(tmp, 't.zip');
  fs.writeFileSync(file, zip);
  if (has('unzip')) {
    const t = execFileSync('unzip', ['-t', file]).toString();
    assert.match(t, /No errors detected/);
    assert.match(execFileSync('unzip', ['-l', file]).toString(), /Bestellung M.+ller\.txt/);
  }
  if (has('python3')) {
    const py = `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.read('Notizen/Einkauf/Bestellung Müller.txt').decode())`;
    assert.match(execFileSync('python3', ['-c', py, file]).toString(), /Äpfel 12/);
  }
  await assert.rejects(readZip(new Uint8Array(10)), /Keine gueltige ZIP/);
});

// ---------- Suche ----------
test('Suche: Umlaute/ss, Ordner, Anhaenge, UND-Verknuepfung, Ausschnitt', () => {
  const folders = [{ id: 'f1', name: 'Bestellungen' }, { id: 'f2', name: 'Privat' }];
  const notes = [
    { id: 'n1', title: 'Strasse Übersicht', text: 'Strasse Übersicht\nLieferung an Bahnhofstraße 5', folderId: 'f1', modified: 2 },
    { id: 'n2', title: 'Einkauf', text: 'Einkauf\nMilch Brot', folderId: 'f2', modified: 1 },
    { id: 'n3', title: 'Gelöscht', text: 'Milch', folderId: 'f2', deleted: 5 },
  ];
  const files = [{ id: 'a1', noteId: 'n2', name: 'Rechnung Migros.pdf', text: 'Total CHF 45.20' }, { id: 'a2', noteId: 'n3', name: 'weg.pdf', text: 'Milch' }];
  const idx = buildIndex({ folders, notes, files });
  assert.equal(normalize('Straße ÜBER'), 'strasse uber');
  assert.deepEqual(search(idx, 'uebersicht').map((r) => r.id), []);
  assert.deepEqual(search(idx, 'ubersicht').map((r) => r.id), ['n1']);
  assert.deepEqual(search(idx, 'bahnhofstrasse').map((r) => r.id), ['n1']);
  assert.deepEqual(search(idx, 'milch').map((r) => r.id), ['n2']); // geloeschte nicht
  assert.deepEqual(search(idx, 'migros').map((r) => r.id), ['a1']);
  assert.deepEqual(search(idx, 'chf 45').map((r) => r.id), ['a1']);
  assert.deepEqual(search(idx, 'bestellungen').map((r) => r.kind), ['folder']);
  assert.deepEqual(search(idx, 'milch xyz'), []);
  const sn = snippet('Lieferung an Bahnhofstraße 5 morgen', 'bahnhofstrasse');
  assert.equal(sn.match, 'Bahnhofstraße');
  // Geschwindigkeit: 5000 Notizen
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: 'x' + i, title: 'Notiz ' + i, text: 'Lorem ipsum dolor sit amet '.repeat(40) + i, folderId: 'f1', modified: i }));
  const big = buildIndex({ folders, notes: many, files: [] });
  const t0 = performance.now();
  const r = search(big, 'amet 4999');
  const ms = performance.now() - t0;
  assert.ok(r.some((x) => x.id === 'x4999'));
  assert.ok(ms < 100, `Suche dauerte ${ms} ms`);
});

// ---------- Ordner ----------
test('Ordnerbaum: Pfad, Unterordner, Verschieben ohne Zyklus, Loeschplan, Namen', () => {
  const F = [
    { id: 'a', name: 'Arbeit', parentId: null }, { id: 'b', name: 'Bestellungen', parentId: 'a' },
    { id: 'c', name: '2026', parentId: 'b' }, { id: 'd', name: 'Privat', parentId: null },
  ];
  assert.deepEqual(pathOf(F, 'c'), ['Arbeit', 'Bestellungen', '2026']);
  assert.deepEqual(descendantIds(F, 'a').sort(), ['a', 'b', 'c']);
  assert.equal(canMoveFolder(F, 'a', 'c'), false);
  assert.equal(canMoveFolder(F, 'c', 'd'), true);
  assert.throws(() => moveFolder(F, 'a', 'b'));
  const moved = moveFolder(F, 'b', 'd');
  assert.deepEqual(pathOf(moved, 'c'), ['Privat', 'Bestellungen', '2026']);
  assert.deepEqual(flattenTree(F).map((x) => `${x.depth}:${x.folder.name}`), ['0:Arbeit', '1:Bestellungen', '2:2026', '0:Privat']);
  assert.deepEqual(flattenTree(F, new Set(['a'])).map((x) => x.folder.id), ['a', 'd']);
  const notes = [{ id: 'n1', folderId: 'c' }, { id: 'n2', folderId: 'd' }, { id: 'n3', folderId: 'b', deleted: 1 }];
  assert.deepEqual(planDeleteFolder(F, notes, 'a'), { folderIds: ['a', 'b', 'c'], noteIds: ['n1'] });
  assert.equal(validateFolderName(F, '  bestellungen ', 'a').ok, false);
  assert.equal(validateFolderName(F, 'Bestellungen', null).ok, true);
  assert.equal(validateFolderName(F, '   ', null).ok, false);
});

// ---------- Teilen ----------
test('Share-Target: Link im Textfeld, Dateien, CSV', () => {
  const items = parseShared({ title: 'Artikel', text: 'Lies das https://www.nzz.ch/artikel?id=1).', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 5 }, { name: 'leer.txt', type: 'text/plain', size: 0 }, { name: 'x.docx', type: '', size: 9 }] });
  assert.deepEqual(items.map((i) => i.kind), ['text', 'url', 'file', 'file']);
  assert.equal(items[1].url, 'https://www.nzz.ch/artikel?id=1');
  assert.equal(items[0].text, 'Lies das');
  assert.equal(items[2].fileKind, 'image');
  assert.equal(items[3].fileKind, 'other');
  assert.equal(pdfConvertible('other'), false);
  assert.equal(classifyFile('Scan.PDF', ''), 'pdf');
  assert.equal(classifyFile('memo.m4a', ''), 'audio');
  assert.equal(classifyFile('liste.csv', 'text/csv'), 'csv');
  assert.match(describeItems(items), /Ein Bild/);
  assert.deepEqual(parseShared({ text: 'https://example.com' }).map((i) => i.kind), ['url']);
  assert.equal(parseShared({ title: 'https://a.ch/x' }).find((i) => i.kind === 'url').url, 'https://a.ch/x');
  assert.deepEqual(parseCsv('Artikel;Menge\n"Äpfel; rot";12\n\nBirnen;3\n'), [['Artikel', 'Menge'], ['Äpfel; rot', '12'], ['Birnen', '3']]);
  assert.deepEqual(parseCsv('a,b\n"x ""y""",2'), [['a', 'b'], ['x "y"', '2']]);
});

// ---------- Export-Dateien ----------
test('Dateinamen, eindeutige Namen, Anhangs-Links, Sicherungs-Layout', () => {
  assert.equal(safeFileName('Bestellung: 12/2026 <neu>?'), 'Bestellung 12 2026 neu');
  assert.equal(safeFileName('...'), 'Notiz');
  assert.equal(safeFileName('CON'), '_CON');
  const names = assignFileNames([{ id: 'b', title: 'Einkauf', created: 2 }, { id: 'a', title: 'Einkauf', created: 1 }, { id: 'c', title: 'einkauf', created: 3 }]);
  assert.deepEqual([names.get('a'), names.get('b'), names.get('c')], ['Einkauf', 'Einkauf (2)', 'einkauf (3)']);
  const an = assignAttachmentNames([{ id: '1', name: 'Scan.pdf' }, { id: '2', name: 'Scan.pdf' }]);
  assert.equal(an.get('2'), 'Scan (2).pdf');
  const html = linkAttachments('<p>x</p><div class="att" data-att="a1"></div>', new Map([['a1', { href: 'N%20–%20Anhänge/m.webm', name: 'm.webm', kind: 'audio' }]]));
  assert.match(html, /<a href="N%20–%20Anhänge\/m.webm">📎 m.webm<\/a>/);
  assert.match(html, /<audio controls="" src=/);
  assert.match(standaloneHtml({ title: 'A & B', bodyHtml: '<p>x</p>' }), /<title>A &amp; B<\/title>/);

  const folders = [{ id: 'f1', name: 'Arbeit', parentId: null }, { id: 'f2', name: 'Bestellungen', parentId: 'f1' }];
  const notes = [
    { id: 'n1', folderId: 'f2', title: 'Liste', html: '<h1>Liste</h1><div class="att" data-att="a1"></div>', created: 1, modified: 1 },
    { id: 'n2', folderId: 'f2', title: 'Liste', html: '<p>Liste</p>', created: 2, modified: 2 },
    { id: 'n3', folderId: 'f1', title: 'Alt', html: '<p>Alt</p>', created: 3, modified: 3, deleted: 9 },
  ];
  const files = [{ id: 'a1', noteId: 'n1', name: 'Rechnung.pdf', kind: 'pdf', blob: new Blob(['%PDF']) }];
  const plan = planLayout(folders, notes, files);
  assert.deepEqual(plan.get('n1').segs, ['Arbeit', 'Bestellungen']);
  assert.equal(plan.get('n2').base, 'Liste (2)');
  assert.deepEqual(plan.get('n3').segs, [TRASH_DIR]);
  const outs = noteOutputs(notes[0], plan.get('n1'), folders);
  assert.deepEqual(outs.map((o) => [...o.segs, o.name].join('/')), ['Arbeit/Bestellungen/Liste.html', 'Arbeit/Bestellungen/Liste.txt', 'Arbeit/Bestellungen/Liste – Anhänge/Rechnung.pdf']);
  assert.match(outs[0].data, /Rechnung\.pdf/);
  assert.match(outs[1].data, /\[Anhang: Rechnung\.pdf\]/);
});

test('PDF-Modus: geteilter Text + Link werden zu einem PDF zusammengefasst', () => {
  const items = parseShared({ title: 'Artikel', text: 'Schau mal https://www.srf.ch/news', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 3 }] });
  const merged = mergeTextForPdf(items);
  assert.deepEqual(merged.map((i) => i.kind), ['text', 'file']);
  assert.equal(merged[0].text, 'Schau mal\n\nhttps://www.srf.ch/news');
  assert.equal(mergeTextForPdf(parseShared({ html: '<p>x</p>', url: 'https://a.ch' })).length, 2);
});

// ================= Version 2 =================
test('V2 Suche: Treffer-Positionen im Originaltext (ß/ss, Akzente, Gross/klein)', () => {
  assert.deepEqual(findMatches('Die Straße in Zürich, STRASSE', 'strasse zurich'), [{ start: 4, end: 10 }, { start: 14, end: 20 }, { start: 22, end: 29 }]);
  const t = 'Die Straße in Zürich';
  const [m] = findMatches(t, 'STRASSE');
  assert.equal(t.slice(m.start, m.end), 'Straße');
  // zerlegtes ü (u + Akzentzeichen) wird ganz markiert
  const d = 'Mu\u0308ller';
  const [m2] = findMatches(d, 'mul');
  assert.equal(d.slice(m2.start, m2.end), 'Mu\u0308l');
  // ein "s" in "ß" markiert das ganze ß, Ueberlappungen werden zusammengefasst
  assert.deepEqual(findMatches('aßb', 's'), [{ start: 1, end: 2 }]);
  assert.deepEqual(findMatches('Strasse', 'stras asse'), [{ start: 0, end: 7 }]);
  assert.deepEqual(findMatches('abc', ''), []);
});

test('V2 HEIC/HEIF gilt als Bild', () => {
  assert.equal(classifyFile('IMG_0001.heic', 'image/heic'), 'image');
  assert.equal(classifyFile('IMG_0002.HEIF', ''), 'image');
  assert.equal(classifyFile('x', 'image/heif-sequence'), 'image');
  assert.equal(isHeic('a.jpg', 'image/jpeg'), false);
  assert.equal(classifyFile('scan.tiff', 'image/tiff'), 'other');
});

test('V2 createPdf veraendert die Eingabe nicht', () => {
  const blocks = htmlToBlocks('<p>Hallo</p><div class="att" data-att="a-1-abcd"></div><img src="data:image/png;base64,AAAA"><table><tr><th>A</th></tr></table>');
  const before = JSON.stringify(blocks);
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'att', 'img', 'table']);
  const pdf1 = createPdf({ title: 'T', blocks, attName: () => 'X.pdf', date: new Date(0) });
  assert.equal(JSON.stringify(blocks), before);
  const pdf2 = createPdf({ title: 'T', blocks, attName: () => 'X.pdf', date: new Date(0) });
  assert.deepEqual(pdf1, pdf2); // zweiter Export identisch
  const raw = Buffer.from(pdf2).toString('latin1');
  assert.ok(raw.includes('(Anhang:) Tj') && raw.includes('(X.pdf) Tj') && raw.includes('([Bild]) Tj'));
});

const pyDeflate = (src, dst) => execFileSync('python3', ['-c',
  `import zipfile,sys
s=zipfile.ZipFile(sys.argv[1]); d=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for i in s.infolist(): d.writestr(i.filename, s.read(i.filename))
d.close(); print(zipfile.ZipFile(sys.argv[2]).infolist()[0].compress_type)`, src, dst]).toString().trim();

test('V2 ZIP: Deflate (mit Python neu gepackt) wird gelesen, andere Methoden klar abgelehnt', { skip: !has('python3') }, async () => {
  const text = 'Grüezi Äpfel '.repeat(500);
  const src = path.join(tmp, 'store.zip'), dst = path.join(tmp, 'deflate.zip');
  fs.writeFileSync(src, makeZip([{ name: 'Ordner/Notiz Müller.txt', data: text }, { name: 'bin.dat', data: new Uint8Array(3000).map((_, i) => i % 7) }]));
  assert.equal(pyDeflate(src, dst), '8');
  const bytes = new Uint8Array(fs.readFileSync(dst));
  assert.ok(bytes.length < fs.statSync(src).size, 'wirklich komprimiert');
  const files = await readZip(bytes);
  assert.equal(new TextDecoder().decode(files.find((f) => f.name === 'Ordner/Notiz Müller.txt').data), text);
  assert.equal(files.find((f) => f.name === 'bin.dat').data[13], 13 % 7);
  // Methode 12 (bzip2) vortaeuschen -> verstaendliche Meldung
  const bad = new Uint8Array(fs.readFileSync(src));
  const v = new DataView(bad.buffer);
  for (let i = 0; i < bad.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) v.setUint16(i + 10, 12, true);
  await assert.rejects(readZip(bad), /nicht unterstützten Verfahren gepackt \(Methode 12\)/);
});

test('V2 Notizen-Sicherung, die mit Deflate neu gepackt wurde, laesst sich wiederherstellen', { skip: !has('python3') }, async () => {
  const backup = { app: 'Notizen', format: 1, folders: [{ id: 'f-default', name: 'Notizen', parentId: null }],
    notes: [{ id: 'n1', folderId: 'f-default', title: 'Test', html: '<p>Test</p><div class="att" data-att="a-1-abcd"></div>' }],
    files: [{ id: 'a-1-abcd', noteId: 'n1', name: 'r.pdf', type: 'application/pdf', kind: 'pdf', zipPath: 'Notizen/Notizen/Test – Anhänge/r.pdf' }] };
  const src = path.join(tmp, 'b-store.zip'), dst = path.join(tmp, 'b-deflate.zip');
  fs.writeFileSync(src, makeZip([{ name: 'Notizen/Notizen/Test – Anhänge/r.pdf', data: '%PDF-1.4 test' }, { name: '_wiederherstellung/backup.json', data: JSON.stringify(backup) }]));
  pyDeflate(src, dst);
  const data = await readBackupZip(new Blob([fs.readFileSync(dst)]));
  assert.equal(data.notes[0].title, 'Test');
  assert.equal(await data.files[0].blob.text(), '%PDF-1.4 test');
  await assert.rejects(readBackupZip(new Blob([makeZip([{ name: 'x.txt', data: 'x' }])])), /keine Notizen-Sicherung/);
});

test('V2 Sicherung enthaelt nur noch verwendete Anhaenge', () => {
  const plan = planLayout([{ id: 'f', name: 'A', parentId: null }], [{ id: 'n', folderId: 'f', title: 'N', html: '<div class="att" data-att="a-keep"></div>', created: 1 }],
    [{ id: 'a-keep', noteId: 'n', name: 'k.pdf' }, { id: 'a-weg', noteId: 'n', name: 'weg.pdf' }]);
  assert.deepEqual(plan.get('n').files.map((f) => f.id), ['a-keep']);
});
