// Bilder verkleinern/umwandeln und Sprachaufnahmen (nur Browser-Funktionen, kein Netz).

/** Datei/Blob -> verkleinertes JPEG als data:-URL. scan: Graustufen + Kontrast (Dokument-Look). */
export async function imageToJpeg(blob, { max = 1600, quality = 0.85, scan = false } = {}) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => null);
  let src = bmp, w, h;
  if (bmp) { w = bmp.width; h = bmp.height; }
  else {
    // Ersatzweg ueber <img>
    const url = URL.createObjectURL(blob);
    try {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild kann nicht gelesen werden')); i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); // Transparenz -> weiss
  ctx.drawImage(src, 0, 0, cw, ch);
  if (bmp) bmp.close();
  if (scan) {
    const img = ctx.getImageData(0, 0, cw, ch), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g = Math.max(0, Math.min(255, (g - 128) * 1.6 + 150)); // heller Hintergrund, kraeftige Schrift
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
  }
  return c.toDataURL('image/jpeg', quality);
}

export async function dataUrlToBlob(url) { return (await fetch(url)).blob(); }

/** Wandelt alle Nicht-JPEG-Bilder zu JPEG (der PDF-Generator kann nur JPEG).
 *  Gibt eine NEUE Liste zurueck; die Eingabe bleibt unveraendert. */
export async function jpegifyBlocks(blocks) {
  return Promise.all(blocks.map(async (b) => {
    if (b.type !== 'img' || /^data:image\/jpe?g/i.test(b.src)) return b;
    try { return { ...b, src: await imageToJpeg(await dataUrlToBlob(b.src), { max: 2000, quality: 0.9 }) }; } catch { return b; /* bleibt Platzhalter */ }
  }));
}

export function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

// ---- Sprachaufnahme ----
export function recordingSupported() { return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }

function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

/** Startet eine Aufnahme. Rueckgabe: { stop(): Promise<Blob>, cancel(), mime } */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);
  const end = () => stream.getTracks().forEach((t) => t.stop());
  return {
    mime: rec.mimeType || mime || 'audio/webm',
    stop: () => new Promise((res) => { rec.onstop = () => { end(); res(new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] })); }; rec.stop(); }),
    cancel: () => { try { rec.stop(); } catch {} end(); },
  };
}

export function audioExt(type) { return type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'; }
