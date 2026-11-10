// Teilen (E-Mail, WhatsApp ...) ueber das Android-Teilen-Menue (navigator.share).
// Wo Teilen nicht geht (z. B. Desktop-Firefox), wird die Datei heruntergeladen.
import { htmlToBlocks, blocksToText } from './blocks.js';
import { createPdf } from './pdf.js';
import { jpegifyBlocks } from './media.js';
import { safeFileName } from './exportfmt.js';
import { dialog, toast } from './ui.js';

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Teilt Dateien; bei Bedarf mit einem zweiten Tippen (Browser verlangt frische Benutzeraktion). */
export async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }); return 'shared'; }
    catch (e) {
      if (e.name === 'AbortError') return 'aborted';
      if (e.name === 'NotAllowedError') {
        const r = await dialog({ title: 'Bereit zum Teilen', text: files.map((f) => f.name).join(', '), buttons: [{ id: 'share', label: 'Jetzt teilen', kind: 'primary' }, { id: 'dl', label: 'Herunterladen' }] });
        if (r === 'share') { try { await navigator.share({ files, title }); return 'shared'; } catch (e2) { if (e2.name === 'AbortError') return 'aborted'; } }
        if (r !== 'dl') return 'aborted';
      }
    }
  }
  for (const f of files) download(f, f.name);
  toast('Datei wurde heruntergeladen (Ordner «Downloads»).');
  return 'downloaded';
}

export async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Text in die Zwischenablage kopiert.'); }
  catch { download(new Blob([text], { type: 'text/plain;charset=utf-8' }), safeFileName(title) + '.txt'); }
}

/** Notiz -> PDF-Datei (mit Tabellen, Ueberschriften, Bildern). */
export async function notePdf(note, attName) {
  const blocks = await jpegifyBlocks(htmlToBlocks(note.html || ''));
  const bytes = createPdf({ title: note.title, blocks, attName });
  return new File([bytes], safeFileName(note.title, 'Notiz') + '.pdf', { type: 'application/pdf' });
}

export function noteText(note, attName) {
  return blocksToText(htmlToBlocks(note.html || ''), (id) => `[Anhang: ${attName(id)}]`);
}

/** Drucken bzw. "Als PDF speichern" ueber den Druckdialog des Browsers (beste Optik). */
export function printNote(html) {
  const area = document.getElementById('print-area');
  area.innerHTML = html;
  document.body.classList.add('printing');
  const clean = () => { document.body.classList.remove('printing'); area.innerHTML = ''; };
  window.addEventListener('afterprint', clean, { once: true });
  window.print();
}
