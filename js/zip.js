// Minimaler ZIP-Schreiber/-Leser (Methode "STORE" = ohne Kompression).
// Reicht fuer Sicherungen: Bilder/PDF/Audio sind ohnehin schon komprimiert.
// Dateinamen in UTF-8 (Flag 0x0800), damit Umlaute korrekt erscheinen.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Erstellt ein ZIP. entries: [{ name: 'Ordner/Datei.txt', data: Uint8Array|string, date?: Date }]
 * Gibt eine Liste von Uint8Array-Teilen zurueck (spart Speicher; im Browser: new Blob(teile)).
 */
export function zipParts(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    let name = String(e.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    const data = typeof e.data === 'string' ? utf8(e.data) : e.data;
    const nameBytes = utf8(name);
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.date || new Date());
    const local = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, nameBytes.length, true); v.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const cen = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true); c.setUint32(38, name.endsWith('/') ? 0x10 : 0, true); c.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + data.length;
    if (offset > 0xffffffff) throw new Error('Sicherung zu gross fuer ZIP (ueber 4 GB)');
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

export function makeZip(entries) {
  const parts = zipParts(entries);
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Entpackt "raw deflate" (ZIP-Methode 8) mit der eingebauten Browser-Funktion. */
async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann komprimierte ZIP-Dateien nicht entpacken. Bitte die Original-Sicherung der App (unkomprimiert) verwenden.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Liest ein ZIP. Unterstuetzt unkomprimierte Eintraege (so schreibt diese App)
 * und "Deflate" (so packen die meisten Programme, z. B. Datei-Manager neu).
 * Gibt eine Liste { name, data: Uint8Array } zurueck (asynchron).
 */
export async function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gueltige ZIP-Datei');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Diese ZIP-Datei ist zu gross (ZIP64) und wird nicht unterstützt.');
  const dec = new TextDecoder();
  const files = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschaedigt');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const localOff = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // Ordner-Eintrag
    if (flags & 1) throw new Error(`«${name}» ist verschluesselt. Bitte eine ZIP-Datei ohne Passwort verwenden.`);
    const lNameLen = v.getUint16(localOff + 26, true), lExtra = v.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtra;
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`«${name}» ist mit einem nicht unterstützten Verfahren gepackt (Methode ${method}). Bitte die Original-Sicherung der App oder eine normale ZIP-Datei verwenden.`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`Pruefsumme falsch: ${name} (Datei beschaedigt)`);
    files.push({ name, data });
  }
  return files;
}
