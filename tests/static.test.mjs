// Statische Pruefungen: keine fremden Server, Cache-Liste vollstaendig, CSP, Manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const appFiles = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', ...fs.readdirSync(path.join(ROOT, 'js')).map((f) => 'js/' + f)];

test('keine externen Adressen im App-Code (ausser SVG-Namensraum)', () => {
  for (const f of appFiles) {
    const urls = (read(f).match(/https?:\/\/[^\s"'`)]+/g) || []).filter((u) => !u.startsWith('http://www.w3.org/2000/svg'));
    assert.deepEqual(urls, [], f);
  }
});

test('Service Worker cached alle Dateien, Cache-Name versioniert', () => {
  const sw = read('sw.js');
  const list = Function(`return ${sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]}`)();
  for (const u of list) {
    const file = u === './' ? 'index.html' : u.replace(/^\.\//, '').replace(/\?.*$/, '');
    assert.ok(fs.existsSync(path.join(ROOT, file)), u);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'js'))) assert.ok(list.some((u) => u.startsWith('./js/' + f)), f);
  assert.match(sw, /const CACHE = 'notizen-v' \+ VERSION/);
  assert.match(sw, /cache: 'reload'/);
});

test('index.html: CSP, Manifest, versionierte Skripte', () => {
  const html = read('index.html');
  assert.match(html, /Content-Security-Policy" content="default-src 'self'; script-src 'self';/);
  assert.match(html, /js\/app\.js\?v=2/);
  assert.match(html, /lang="de-CH"/);
  assert.doesNotMatch(html, /<script(?![^>]*type="module" src=)/); // keine Inline-Skripte
});

test('Manifest: installierbar + Teilen-Ziel mit Dateien', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'Notizen');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.purpose === 'maskable'));
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.equal(m.share_target.params.files[0].name, 'files');
});

test('Schweizer Schreibweise in der Oberflaeche (kein ß)', () => {
  for (const f of ['index.html', 'js/app.js', 'js/importer.js', 'js/share.js', 'js/backup.js', 'js/ui.js']) {
    const lines = read(f).split('\n').filter((l) => l.includes('ß') && !/normalize|\/\/|^\s*\*|'ß'|ß\/g/.test(l));
    assert.deepEqual(lines, [], f);
  }
});
