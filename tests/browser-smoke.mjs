// Browser-Rauchtest mit echtem (headless) Chrome ueber das DevTools-Protokoll.
// Optional – braucht google-chrome/chromium und python3. Start:
//   node tests/browser-smoke.mjs
// Prueft: Start ohne Fehler, Notiz schreiben, Tabelle, Checkliste, Einfuege-Abfrage
// (Original + PDF), Speichern, Suche, Ordner, Teilen-PDF, ZIP, Ordner-Sicherung
// (ueber das private Browser-Dateisystem als Ersatz fuer einen echten Ordner),
// Share-Target ueber den Service Worker. Screenshots landen in /tmp/notizen-shots.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 18765, DBG = 19333; // ungewoehnliche Ports, damit nichts anderes stoert
const SHOTS = '/tmp/notizen-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeBin = ['google-chrome', 'chromium', 'chromium-browser'].find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!chromeBin) { console.log('SKIP: kein Chrome gefunden'); process.exit(0); }

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notizen-chrome-'));
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let ws, msgId = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Seite: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await evaluate(`return !!(${expr})`)) return; await sleep(100); }
  throw new Error('Timeout: ' + expr);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '-', e.message); }
}

async function main() {
  let ver;
  for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json(); break; } catch { await sleep(200); } }
  const target = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) errors.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const URL0 = `http://127.0.0.1:${PORT}/`;
  await send('Page.navigate', { url: URL0 });
  await waitFor('window.__notizen && document.querySelector("#folder-list li")', 8000);
  await waitFor('navigator.serviceWorker.controller', 8000).catch(async () => { await send('Page.reload'); await waitFor('window.__notizen && navigator.serviceWorker.controller', 8000); });
  await waitFor('window.__notizen && document.querySelector("#folder-list li")', 8000);

  await step('Start: Ordnerliste mit Hauptordner, SW aktiv, Manifest erreichbar', async () => {
    const r = await evaluate(`const m = await (await fetch('manifest.webmanifest?v=2')).json();
      return { rows: document.querySelectorAll('#folder-list li').length, name: m.name, share: m.share_target.action, sw: !!navigator.serviceWorker.controller,
        caches: await caches.keys() }`);
    assert.equal(r.rows, 3); assert.equal(r.name, 'Notizen'); assert.equal(r.sw, true); assert.deepEqual(r.caches, ['notizen-v2']);
    await shot('01-ordner');
  });

  await step('Neuer Ordner + Unterordner ueber Dialog', async () => {
    await evaluate(`document.querySelector('#btn-new-folder').click()`);
    await waitFor('document.querySelector("dialog[open] input")');
    await evaluate(`const i = document.querySelector('dialog[open] input'); i.value = 'Geschäft'; document.querySelector('dialog[open] .btn.primary').click()`);
    await waitFor('[...document.querySelectorAll(".folder-row .name")].some(e => e.textContent === "Geschäft")');
    await evaluate(`const f = __notizen.S.folders.find(f => f.name === 'Geschäft'); [...document.querySelectorAll('.folder-row')].find(r => r.textContent.includes('Geschäft')).querySelector('.more').click()`);
    await waitFor('document.querySelector("dialog[open]")');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Neuer Unterordner').click()`);
    await waitFor('document.querySelector("dialog[open] input")');
    await evaluate(`const i = document.querySelector('dialog[open] input'); i.value = 'Bestellungen'; document.querySelector('dialog[open] .btn.primary').click()`);
    await waitFor('__notizen.S.folders.some(f => f.name === "Bestellungen" && f.parentId)');
    await shot('02-ordner-baum');
  });

  await step('Notiz schreiben: Titel, Text, Fett, Checkliste, Tabelle -> gespeichert', async () => {
    await evaluate(`const f = __notizen.S.folders.find(f => f.name === 'Bestellungen'); __notizen.openFolder(f.id); await __notizen.newNote();`);
    await waitFor('document.querySelector("#app").dataset.view === "editor"');
    await evaluate(`
      const ed = document.querySelector('#editor'); ed.focus();
      document.execCommand('insertText', false, 'Bestellung Bäckerei Müller');
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, 'Lieferung am Freitag ');
      document.execCommand('bold'); document.execCommand('insertText', false, 'dringend'); document.execCommand('bold');
      document.execCommand('insertParagraph');
      document.querySelector('#tb-check').click();
      document.execCommand('insertText', false, 'Mehl bestellen');
      document.execCommand('insertParagraph'); document.execCommand('insertText', false, 'Hefe');
      document.execCommand('insertParagraph'); document.execCommand('insertParagraph');
      document.querySelector('#tb-table').click();
      document.execCommand('insertText', false, 'Artikel');
      const cells = () => ed.querySelectorAll('table th, table td');
      const put = (i, t) => { const r = document.createRange(); r.selectNodeContents(cells()[i]); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, t); };
      put(1, 'Menge'); put(2, 'Preis'); put(3, 'Mehl Typ 550'); put(4, '25 kg'); put(5, 'CHF 31.50');
      put(3, ''); document.querySelector('[data-table="addRow"]').click(); put(6, 'Hefe frisch');
      const li = ed.querySelector('ul.checklist li'); const rect = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 8 }));
      await __notizen.saveNow();`);
    const n = await evaluate(`const n = __notizen.S.notes.find(n => n.id === __notizen.S.noteId); return n && { title: n.title, html: n.html, text: n.text }`);
    if (process.env.DEBUG) console.log(n.html);
    assert.equal(n.title, 'Bestellung Bäckerei Müller');
    assert.match(n.html, /<h1>Bestellung Bäckerei Müller<\/h1>/);
    assert.match(n.html, /<b>dringend<\/b>/);
    assert.match(n.html, /<ul class="checklist"><li data-checked="true">Mehl bestellen<\/li><li>Hefe<\/li><\/ul>/);
    assert.match(n.html, /<table class="note-table"><tbody><tr><th>Artikel<\/th><th>Menge<\/th><th>Preis<\/th><\/tr>/);
    assert.match(n.html, /Hefe frisch/);
    assert.equal((n.html.match(/<tr>/g) || []).length, 4);
    await shot('03-editor-tabelle');
  });

  await step('Format-Panel: Farbe und Groesse', async () => {
    await evaluate(`document.querySelector('#tb-format').click();
      const ed = document.querySelector('#editor'); const p = ed.querySelector('p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('[data-color="#1a73e8"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.selectNodeContents(ed.querySelector('p')); s.removeAllRanges(); s.addRange(r);
      document.querySelector('[data-size="22px"]').click();
      await __notizen.saveNow();`);
    await shot('04-format-panel');
    const html = await evaluate(`return __notizen.S.notes.find(n => n.title.startsWith('Bestellung')).html`);
    assert.match(html, /color: rgb\(26, 115, 232\)|color: #1a73e8/);
    assert.match(html, /font-size: 22px/);
    await evaluate(`document.querySelector('#tb-format').click()`);
  });

  await step('Einfuegen: Abfrage erscheint, "Als PDF" erzeugt PDF-Anhang mit Vorschau', async () => {
    await evaluate(`const ed = document.querySelector('#editor'); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
      const dt = new DataTransfer(); dt.setData('text/html', '<h2>Webseite</h2><p>Artikel über Zürich<script>x()</script></p><table><tr><td>A</td><td>B</td></tr></table>'); dt.setData('text/plain', 'Webseite Artikel über Zürich');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));`);
    await waitFor('document.querySelector("dialog.dlg-import[open]")');
    const t = await evaluate(`return document.querySelector('dialog.dlg-import').textContent`);
    assert.match(t, /Möchtest du den Inhalt als Original \(bearbeitbar\) oder als PDF speichern\?/);
    await shot('05-abfrage');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Als PDF').click()`);
    await waitFor('document.querySelector("#editor .att .att-head")');
    const r = await evaluate(`await __notizen.saveNow(); const f = [...__notizen.S.files.values()].find(f => f.kind === 'pdf'); const b = new Uint8Array(await f.blob.arrayBuffer());
      return { name: f.name, head: String.fromCharCode(...b.slice(0, 8)), text: f.text, card: document.querySelector('#editor .att').textContent }`);
    assert.equal(r.head, '%PDF-1.4');
    assert.match(r.name, /\.pdf$/);
    assert.match(r.text, /Artikel über Zürich/);
    assert.match(r.card, /Öffnen/);
    await evaluate(`document.querySelector('#editor .att').scrollIntoView()`);
    await shot('06-pdf-karte');
  });

  await step('Einfuegen: "Original" fuegt bereinigtes, bearbeitbares HTML ein', async () => {
    await evaluate(`const ed = document.querySelector('#editor'); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
      const dt = new DataTransfer(); dt.setData('text/html', '<p onclick="x()">Kopiert <i>kursiv</i><img src="https://example.com/t.gif"></p>'); dt.setData('text/plain', 'Kopiert kursiv');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));`);
    await waitFor('document.querySelector("dialog.dlg-import[open]")');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent.startsWith('Original')).click()`);
    await sleep(300);
    const html = await evaluate(`await __notizen.saveNow(); return __notizen.S.notes.find(n => n.title.startsWith('Bestellung')).html`);
    assert.match(html, /Kopiert <i>kursiv<\/i>/);
    assert.doesNotMatch(html, /onclick|<img src="https/);
    assert.match(html, /\[Bild\]/); // externes Bild nur als Link, wird nicht geladen
  });

  await step('Datei, die nicht in PDF umgewandelt werden kann (docx) -> Erklaerung, Original bleibt', async () => {
    const p = evaluate(`await __notizen.importItems(__notizen.parseShared({ files: [new File(['PK..'], 'Offerte.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })] })); return true`);
    await waitFor('document.querySelector("dialog.dlg-import[open]")');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Als PDF').click()`);
    await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog[open]").textContent.includes("Nicht als PDF möglich")');
    await shot('07-docx-hinweis');
    await evaluate(`document.querySelector('dialog[open] .btn.primary').click()`);
    await p;
    const ok = await evaluate(`return [...__notizen.S.files.values()].some(f => f.name === 'Offerte.docx')`);
    assert.equal(ok, true);
  });

  await step('Foto aus Galerie wird verkleinert als JPEG eingefuegt', async () => {
    await evaluate(`const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 3000, 2000);
      const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'foto.png', { type: 'image/png' }));
      const inp = document.querySelector('#in-gallery'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
    await waitFor('document.querySelector("#editor img")', 5000);
    const r = await evaluate(`const img = document.querySelector('#editor img'); await img.decode(); return { w: img.naturalWidth, src: img.src.slice(0, 23) }`);
    assert.equal(r.w, 1600); assert.equal(r.src, 'data:image/jpeg;base64,');
  });

  await step('Sprachmemo: Aufnahme (Test-Mikrofon) wird als Anhang mit Player eingefuegt', async () => {
    await evaluate(`document.querySelector('#tb-audio').click()`);
    await waitFor('document.querySelector("dialog[open] .rec-time")', 5000);
    await sleep(1500);
    await shot('06b-aufnahme');
    await evaluate(`document.querySelector('dialog[open] .btn.primary').click()`);
    await waitFor('document.querySelector("#editor .att audio")', 5000);
    const r = await evaluate(`const f = [...__notizen.S.files.values()].find(f => f.kind === 'audio'); return { name: f.name, size: f.size, type: f.type }`);
    assert.match(r.name, /^Sprachmemo .*\.(webm|ogg|m4a)$/); assert.ok(r.size > 500, 'Audiodaten vorhanden'); assert.match(r.type, /^audio\//);
  });

  await step('Teilen-Knopf: PDF wird erzeugt (ohne Teilen-Menue im Test: Download)', async () => {
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: SHOTS }).catch(() => {});
    await evaluate(`document.querySelector('#btn-share').click()`);
    await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog[open]").textContent.includes("Als PDF senden")');
    await shot('06c-teilen');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Als PDF senden').click()`);
    await waitFor('!document.querySelector("#toast").hidden && /heruntergeladen|geteilt/.test(document.querySelector("#toast").textContent) || window.__shared', 8000);
  });

  await step('Teilen als PDF: Notiz-PDF gueltig (pdftotext), Tabelle + Umlaute', async () => {
    const b64 = await evaluate(`const { notePdf } = await import('./js/share.js'); const n = __notizen.S.notes.find(n => n.title.startsWith('Bestellung'));
      const f = await notePdf(n, id => __notizen.S.files.get(id)?.name || 'Anhang'); const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s)`);
    const file = '/tmp/notizen-shots/notiz.pdf';
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
    assert.match(text, /Bestellung Bäckerei Müller/);
    assert.match(text, /Artikel\s+Menge\s+Preis/);
    assert.match(text, /25 kg\s+CHF 31.50/);
    assert.match(text, /Anhang: .*\.pdf/);
    execFileSync('pdftoppm', ['-r', '50', '-f', '1', '-l', '1', '-png', file, '/tmp/notizen-shots/notiz-pdf']);
  });

  await step('Suche findet Notiz, Ordner und PDF-Inhalt', async () => {
    await evaluate(`await __notizen.closeEditor(); history.back();`); await sleep(300);
    await evaluate(`history.back();`); await sleep(300);
    const r = await evaluate(`const i = document.querySelector('#search-folders'); i.value = 'zurich'; i.dispatchEvent(new Event('input'));
      const a = [...document.querySelectorAll('#search-results-folders .kind')].map(e => e.textContent);
      i.value = 'bestellungen'; i.dispatchEvent(new Event('input')); const b = [...document.querySelectorAll('#search-results-folders .kind')].map(e => e.textContent);
      i.value = 'baeckerei'; i.dispatchEvent(new Event('input')); const c = document.querySelectorAll('#search-results-folders li').length;
      i.value = 'backerei mehl'; i.dispatchEvent(new Event('input')); const d = [...document.querySelectorAll('#search-results-folders .kind')].map(e => e.textContent);
      return { a, b, c, d }`);
    assert.ok(r.a.includes('Anhang'), 'PDF-Inhalt gefunden');
    assert.ok(r.b.includes('Ordner'));
    assert.deepEqual(r.d, ['Notiz']);
    await shot('08-suche');
    await evaluate(`const i = document.querySelector('#search-folders'); i.value = ''; i.dispatchEvent(new Event('input'));`);
  });

  await step('ZIP-Sicherung: gueltig, lesbare Dateien + Wiederherstellungsdaten', async () => {
    const b64 = await evaluate(`const f = await __notizen.makeZip(); const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s)`);
    const file = '/tmp/notizen-shots/sicherung.zip';
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    const py = `import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;n=z.namelist();print('\\n'.join(n));b=json.loads(z.read('_wiederherstellung/backup.json'));print('NOTES',len(b['notes']),'FILES',len(b['files']))`;
    const out = execFileSync('python3', ['-c', py, file]).toString();
    assert.match(out, /Notizen\/Geschäft\/Bestellungen\/Bestellung Bäckerei Müller\.html/);
    assert.match(out, /Bestellung Bäckerei Müller – Anhänge\/.*\.pdf/);
    assert.match(out, /Offerte\.docx/);
    assert.match(out, /NOTES 1 FILES 3/);
    const html = execFileSync('python3', ['-c', `import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read('Notizen/Geschäft/Bestellungen/Bestellung Bäckerei Müller.html').decode())`, file]).toString();
    assert.match(html, /<table/); assert.doesNotMatch(html, /<script/);
  });

  await step('ZIP-Sicherung wird wieder eingelesen (Notizen, Ordner, Anhaenge mit Inhalt)', async () => {
    const r = await evaluate(`const f = await __notizen.makeZip(); const data = await __notizen.backup.readBackupZip(f);
      return { notes: data.notes.length, folders: data.folders.length, files: data.files.length, blob: data.files[0].blob.size > 10 }`);
    assert.deepEqual(r, { notes: 1, folders: 3, files: 3, blob: true });
  });

  await step('Ordner-Sicherung schreibt Dateibaum (Test mit privatem Browser-Dateisystem als Ordner)', async () => {
    const r = await evaluate(`const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('TestNotizen', { create: true });
      const db = await import('./js/db.js'); await db.setMeta('dirHandle', dir); await db.setMeta('syncState', {});
      const res = await __notizen.backup.syncFolder();
      const list = []; async function walk(d, p) { for await (const [name, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + name + '/'); else list.push(p + name); } }
      await walk(dir, '');
      // Umbenennen der Notiz -> alte Dateien verschwinden
      const n = __notizen.S.notes[0]; n.html = n.html.replace('Bestellung Bäckerei Müller', 'Bestellung Beck'); n.title = 'Bestellung Beck'; n.modified = Date.now(); await db.put('notes', n);
      await __notizen.backup.syncFolder({ onlyIds: [n.id] });
      const list2 = []; async function walk2(d, p) { for await (const [name, h] of d.entries()) { if (h.kind === 'directory') await walk2(h, p + name + '/'); else list2.push(p + name); } }
      await walk2(dir, '');
      await db.setMeta('dirHandle', null);
      return { res, list: list.sort(), list2: list2.sort() }`);
    assert.equal(r.res.status, 'ok');
    assert.ok(r.list.includes('LIESMICH.txt'));
    assert.ok(r.list.includes('Geschäft/Bestellungen/Bestellung Bäckerei Müller.html'), JSON.stringify(r.list));
    assert.ok(r.list.includes('Geschäft/Bestellungen/Bestellung Bäckerei Müller.txt'));
    assert.ok(r.list.some((p) => p.startsWith('Geschäft/Bestellungen/Bestellung Bäckerei Müller – Anhänge/') && p.endsWith('.pdf')));
    assert.ok(r.list2.includes('Geschäft/Bestellungen/Bestellung Beck.html'), JSON.stringify(r.list2));
    assert.ok(!r.list2.some((p) => p.includes('Müller')), 'alte Dateien entfernt: ' + JSON.stringify(r.list2));
  });

  await step('Ordner loeschen -> Notizen in "Zuletzt geloescht", Wiederherstellen', async () => {
    const r = await evaluate(`const f = __notizen.S.folders.find(f => f.name === 'Geschäft');
      [...document.querySelectorAll('.folder-row')].find(r => r.textContent.includes('Geschäft')).querySelector('.more').click();
      await new Promise(r => setTimeout(r, 100));
      [...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Ordner löschen').click();
      await new Promise(r => setTimeout(r, 200));
      const txt = document.querySelector('dialog[open]').textContent;
      [...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent === 'Ordner löschen').click();
      await new Promise(r => setTimeout(r, 300));
      return { txt, folders: __notizen.S.folders.map(f => f.name), deleted: __notizen.S.notes.filter(n => n.deleted).length }`);
    assert.match(r.txt, /1 Unterordner und 1 Notiz/);
    assert.deepEqual(r.folders, ['Notizen']);
    assert.equal(r.deleted, 1);
    await evaluate(`__notizen.openFolder('trash'); await new Promise(r => setTimeout(r, 100)); document.querySelector('#note-list .note-row').click(); await new Promise(r => setTimeout(r, 200));`);
    await shot('09-papierkorb-notiz');
    await evaluate(`document.querySelector('#btn-restore').click(); await new Promise(r => setTimeout(r, 300));`);
    const n = await evaluate(`const n = __notizen.S.notes[0]; return { deleted: n.deleted, folder: n.folderId }`);
    assert.deepEqual(n, { deleted: false, folder: 'f-default' });
  });

  await step('Share-Target: POST an Service Worker -> Eingang -> Abfrage in neuer Notiz', async () => {
    await evaluate(`await __notizen.closeEditor();
      const fd = new FormData(); fd.append('title', 'Geteilter Artikel'); fd.append('text', 'Schau mal https://www.srf.ch/news');
      const r = await fetch('share-target', { method: 'POST', body: fd }); return r.url`);
    await send('Page.navigate', { url: URL0 + '?share=1' });
    await waitFor('document.querySelector("dialog.dlg-import[open]")', 8000);
    const t = await evaluate(`return document.querySelector('dialog.dlg-import').textContent`);
    assert.match(t, /Link: https:\/\/www\.srf\.ch\/news/);
    await shot('10-geteilt');
    await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b => b.textContent.startsWith('Original')).click()`);
    await sleep(500);
    const html = await evaluate(`await __notizen.saveNow(); return __notizen.S.notes.find(n => n.title === 'Geteilter Artikel')?.html`);
    assert.match(html, /^<h1>Geteilter Artikel<\/h1><p>Schau mal<\/p>/);
    assert.match(html, /<a href="https:\/\/www\.srf\.ch\/news"/);
    await shot('10b-geteilt-eingefuegt');
    await evaluate(`history.back()`); await sleep(300); await shot('10c-notizliste');
    assert.equal(await evaluate(`return location.search`), '');
  });

  // ================= Version 2 =================
  await step('V2 Suche markiert Treffer in der Notiz (ß = ss, Akzente) – hell', async () => {
    await evaluate(`__notizen.openFolder('f-default'); await __notizen.newNote();
      const ed = document.querySelector('#editor'); ed.focus();
      document.execCommand('insertText', false, 'Strassenliste'); document.execCommand('insertParagraph');
      document.execCommand('insertText', false, 'Die Straße in Zürich ist lang.'); await __notizen.saveNow(); await __notizen.closeEditor();`);
    const r = await evaluate(`const id = __notizen.S.notes.find(n => n.title === 'Strassenliste').id;
      await __notizen.openNote(id, { highlight: 'strasse zurich' }); await new Promise(r => setTimeout(r, 300));
      const h = CSS.highlights.get('treffer'); const texts = h ? [...h].map(r => r.toString()) : [];
      let rule = false; for (const sh of document.styleSheets) for (const ru of sh.cssRules) { if ((ru.cssText || '').includes('::highlight(treffer)')) rule = true; if (ru.cssRules) for (const x of ru.cssRules) if ((x.cssText || '').includes('::highlight(treffer)')) rule = true; }
      return { texts, rule }`);
    assert.deepEqual(r.texts, ['Strasse', 'Straße', 'Zürich']); // «Strasse»nliste im Titel + Text
    assert.equal(r.rule, true);
    await shot('v2-01-treffer-hell');
  });

  await step('V2 Suchtreffer anklicken oeffnet Notiz mit Markierung', async () => {
    await evaluate(`await __notizen.closeEditor(); history.back(); await new Promise(r => setTimeout(r, 300));
      const i = document.querySelector('#search-notes'); i.value = 'zurich'; i.dispatchEvent(new Event('input'));`);
    await waitFor('[...document.querySelectorAll("#search-results-notes li")].some(l => l.textContent.includes("Strassenliste"))');
    await evaluate(`[...document.querySelectorAll('#search-results-notes li')].find(l => l.textContent.includes('Strassenliste')).querySelector('button,a,[role=button]')?.click() ?? [...document.querySelectorAll('#search-results-notes li')].find(l => l.textContent.includes('Strassenliste')).click()`);
    await waitFor('document.querySelector("#app").dataset.view === "editor" && CSS.highlights.get("treffer")?.size > 0', 4000);
    const t = await evaluate(`return [...CSS.highlights.get('treffer')].map(r => r.toString())`);
    assert.deepEqual(t, ['Zürich']);
    await evaluate(`const i = document.querySelector('#search-notes'); i.value = ''; i.dispatchEvent(new Event('input'));`);
  });

  await step('V2 HEIC-Foto aus Galerie: kein Absturz, Anhang mit Hinweis', async () => {
    await evaluate(`const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([0,0,0,24,102,116,121,112,104,101,105,99,0,0,0,0])], 'IMG_4711.HEIC', { type: 'image/heic' }));
      const inp = document.querySelector('#in-gallery'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
    await waitFor('[...document.querySelectorAll("#editor .att")].some(a => a.textContent.includes("IMG_4711"))', 5000);
    const r = await evaluate(`const a = [...document.querySelectorAll('#editor .att')].find(a => a.textContent.includes('IMG_4711')); a.scrollIntoView();
      await __notizen.saveNow(); const n = __notizen.S.notes.find(n => n.id === __notizen.S.noteId);
      const f = [...__notizen.S.files.values()].find(f => f.name === 'IMG_4711.HEIC'); return { card: a.textContent, kind: f.kind, note: f.note, cards: document.querySelectorAll('#editor .att').length, inTitle: !!a.closest('h1'), title: n.title, firstIsTitle: document.querySelector('#editor').firstElementChild.tagName }`);
    assert.equal(r.cards, 1); assert.equal(r.inTitle, false); assert.equal(r.title, 'Strassenliste'); assert.equal(r.firstIsTitle, 'H1');
    assert.match(r.card, /HEIC-Bild: Vorschau nicht möglich/);
    assert.equal(r.kind, 'image'); assert.equal(r.note, 'HEIC-Bild: Vorschau nicht möglich');
    await shot('v2-02-heic');
  });

  await step('V2 Toast unten, ueber der Werkzeugleiste, kurz sichtbar', async () => {
    const r = await evaluate(`const ui = await import('./js/ui.js'); ui.toast('Test-Meldung');
      await new Promise(r => setTimeout(r, 50));
      const t = document.querySelector('#toast').getBoundingClientRect();
      const bars = [...document.querySelectorAll('.bottom, #editor-tools, #table-tools')].filter(e => e.offsetParent && !e.hidden).map(e => e.getBoundingClientRect().top);
      const title = document.querySelector('#editor h1').getBoundingClientRect();
      return { top: t.top, bottom: t.bottom, barTop: Math.min(...bars), titleBottom: title.bottom, h: innerHeight }`);
    assert.ok(r.bottom <= r.barTop + 1, 'Toast ueber Werkzeugleiste: ' + JSON.stringify(r));
    assert.ok(r.top > r.h / 2, 'Toast im unteren Bereich: ' + JSON.stringify(r));
    const lines = await evaluate(`const ui = await import('./js/ui.js'); ui.toast('Sicherung wird erstellt …'); const t = document.querySelector('#toast'); return t.getBoundingClientRect().height`);
    assert.ok(lines < 50, 'Hoehe ' + lines + 'px: ' + 'kurze Meldung bricht nicht unnoetig um');
    await shot('v2-03-toast');
    await sleep(2100);
    assert.equal(await evaluate(`return document.querySelector('#toast').hidden`), true);
  });

  await step('V2 Rueckgaengig: Checklisten-Haken', async () => {
    const r = await evaluate(`await __notizen.newNote(); const ed = document.querySelector('#editor'); ed.focus();
      document.execCommand('insertText', false, 'Undo-Test'); document.execCommand('insertParagraph');
      document.querySelector('#tb-check').click(); document.execCommand('insertText', false, 'Milch');
      const li = ed.querySelector('ul.checklist li'); const rc = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rc.left + 10, clientY: rc.top + 8 }));
      const ticked = ed.querySelector('ul.checklist li').dataset.checked;
      document.querySelector('#tb-undo').click();
      const after = ed.querySelector('ul.checklist li')?.dataset.checked ?? null;
      const text = ed.querySelector('ul.checklist li')?.textContent;
      return { ticked, after, text }`);
    assert.deepEqual(r, { ticked: 'true', after: null, text: 'Milch' });
  });

  await step('V2 Rueckgaengig: Zeile/Spalte hinzufuegen und loeschen in Tabelle', async () => {
    const r = await evaluate(`const ed = document.querySelector('#editor');
      const r0 = document.createRange(); r0.selectNodeContents(ed); r0.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r0);
      document.execCommand('insertParagraph'); document.querySelector('#tb-table').click(); document.execCommand('insertText', false, 'Kopf');
      const t = () => ed.querySelector('table'); const dims = () => [t().rows.length, t().rows[0].cells.length];
      const at = (i) => { const c = t().querySelectorAll('th,td')[i]; const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); };
      const out = { start: dims() };
      at(4); document.querySelector('[data-table="addRow"]').click(); out.addRow = dims();
      document.querySelector('#tb-undo').click(); out.undoRow = dims();
      at(4); document.querySelector('[data-table="addCol"]').click(); out.addCol = dims();
      document.querySelector('#tb-undo').click(); out.undoCol = dims();
      at(4); document.querySelector('[data-table="delRow"]').click(); out.delRow = dims();
      document.querySelector('#tb-undo').click(); out.undoDel = dims();
      out.head = t().querySelector('th').textContent;
      return out`);
    assert.deepEqual(r, { start: [3, 3], addRow: [4, 3], undoRow: [3, 3], addCol: [3, 4], undoCol: [3, 3], delRow: [2, 3], undoDel: [3, 3], head: 'Kopf' });
  });

  await step('V2 Rueckgaengig: Anhang entfernen', async () => {
    await evaluate(`const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(20)], 'Beleg.heif', { type: 'image/heif' }));
      const inp = document.querySelector('#in-gallery'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
    await waitFor('[...document.querySelectorAll("#editor .att")].some(a => a.textContent.includes("Beleg.heif"))', 5000);
    await evaluate(`const a = [...document.querySelectorAll('#editor .att')].find(a => a.textContent.includes('Beleg.heif')); [...a.querySelectorAll('button')].find(b => b.textContent === 'Entfernen').click();`);
    await waitFor('document.querySelector("dialog[open]")');
    await evaluate(`document.querySelector('dialog[open] .btn.primary, dialog[open] .btn.danger').click()`);
    await waitFor('![...document.querySelectorAll("#editor .att")].some(a => a.textContent.includes("Beleg.heif"))', 3000);
    await evaluate(`document.querySelector('#tb-undo').click()`);
    await waitFor('[...document.querySelectorAll("#editor .att")].some(a => a.textContent.includes("Beleg.heif") && a.textContent.includes("Herunterladen"))', 3000);
  });

  for (const w of [412, 360]) {
    await step(`V2 Tabellen-Werkzeuge passen bei ${w}px (kein abgeschnittener Knopf)`, async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 2, mobile: true });
      await sleep(250);
      await evaluate(`const c = document.querySelector('#editor table td'); const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); document.querySelector('#editor').focus();`);
      await waitFor('!document.querySelector("#table-tools").hidden', 3000);
      const r = await evaluate(`const bar = document.querySelector('#table-tools'); const b = bar.getBoundingClientRect();
        const btns = [...bar.querySelectorAll('button')].map(x => { const q = x.getBoundingClientRect(); return { t: x.textContent.trim(), clipped: x.scrollWidth > x.clientWidth + 1, out: q.left < b.left - 1 || q.right > b.right + 1 || q.right > innerWidth }; });
        return { overflow: bar.scrollWidth > bar.clientWidth + 1, bad: btns.filter(x => x.clipped || x.out), labels: btns.map(x => x.t) }`);
      assert.equal(r.overflow, false); assert.deepEqual(r.bad, []);
      assert.ok(r.labels.includes('Tabelle löschen'), JSON.stringify(r.labels));
      await shot(`v2-04-tabelle-${w}`);
    });
  }

  await step('V2 Sicherung, extern mit Deflate neu gepackt, wird in Chrome eingelesen', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await evaluate(`await __notizen.saveNow()`);
    const b64 = await evaluate(`const f = await __notizen.makeZip(); const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s)`);
    const src = '/tmp/notizen-shots/v2-store.zip', dst = '/tmp/notizen-shots/v2-deflate.zip';
    fs.writeFileSync(src, Buffer.from(b64, 'base64'));
    execFileSync('python3', ['-c', `import zipfile,sys
s=zipfile.ZipFile(sys.argv[1]); d=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for i in s.infolist(): d.writestr(i.filename, s.read(i.filename))
d.close()`, src, dst]);
    const d64 = fs.readFileSync(dst).toString('base64');
    const r = await evaluate(`const bin = atob('${d64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const data = await __notizen.backup.readBackupZip(new Blob([u]));
      return { notes: data.notes.map(n => n.title).sort(), heic: data.files.some(f => f.name === 'IMG_4711.HEIC' && f.blob.size === 16) }`);
    assert.ok(r.notes.includes('Strassenliste') && r.notes.includes('Undo-Test'), JSON.stringify(r));
    assert.equal(r.heic, true);
  });

  await step('V2 Dunkelmodus: Treffer-Markierung', async () => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await evaluate(`const id = __notizen.S.notes.find(n => n.title === 'Strassenliste').id; await __notizen.openNote(id, { highlight: 'strasse zurich' }); await new Promise(r => setTimeout(r, 300));`);
    assert.equal(await evaluate(`return CSS.highlights.get('treffer').size`), 3);
    assert.equal(await evaluate(`return document.querySelector('#table-tools').hidden`), true, 'Tabellen-Leiste der vorherigen Notiz ausgeblendet');
    await shot('v2-05-treffer-dunkel');
    await send('Emulation.setEmulatedMedia', { features: [] });
  });

  await step('Breite Ansicht (Tablet/Desktop): drei Spalten', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    await shot('11-breit');
    const vis = await evaluate(`return ['#pane-folders', '#pane-notes', '#pane-editor'].map(s => getComputedStyle(document.querySelector(s)).display)`);
    assert.deepEqual(vis.slice(0, 2), ['flex', 'flex']);
  });

  await step('Dunkelmodus', async () => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await shot('12-dunkel');
    const bg = await evaluate(`return getComputedStyle(document.body).backgroundColor`);
    assert.equal(bg, 'rgb(28, 28, 30)');
  });

  await step('Offline: Neuladen ohne Server funktioniert (Service Worker)', async () => {
    server.kill(); await sleep(300);
    await send('Page.reload', { ignoreCache: false });
    await waitFor('window.__notizen && document.querySelector("#folder-list li")', 8000);
  });

  await step('Keine Fehler in der Konsole / CSP', async () => {
    const relevant = errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(e));
    assert.deepEqual(relevant, []);
  });

  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} Browser-Pruefungen bestanden. Screenshots: ${SHOTS}`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); console.error("Konsole:", errors); cleanup(); process.exit(1); });
