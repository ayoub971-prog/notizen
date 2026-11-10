// Kleine UI-Helfer: Elemente bauen, Dialoge (Bestaetigen, Eingabe, Auswahl), Hinweise.

export const $ = (sel, root = document) => root.querySelector(sel);

/** el('button', { class: 'x', onclick: fn }, 'Text', kindElement) */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

let toastTimer;
/** Abstand des Hinweises vom unteren Rand: ueber allen sichtbaren Leisten am
 *  unteren Rand (Werkzeugleiste, Tabellen-Werkzeuge, Format-Panel). Mit
 *  interactive-widget=resizes-content liegt das automatisch ueber der Tastatur. */
function toastBottom() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  let top = vh;
  for (const e of document.querySelectorAll('.bottom, #table-tools, #format-panel')) {
    if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') continue; // unsichtbar
    const r = e.getBoundingClientRect();
    if (r.height && r.bottom > vh - 400 && r.top < top && r.bottom <= vh + 1) top = r.top;
  }
  return Math.max(16, vh - top + 10);
}

export function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.setProperty('--toast-bottom', `${toastBottom()}px`);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/**
 * Allgemeiner Dialog. buttons: [{ id, label, kind: 'primary'|'danger'|'' }]
 * build(body) kann eigenen Inhalt hinzufuegen. Gibt die id des Knopfs oder null zurueck.
 */
export function dialog({ title, text, buttons = [{ id: 'ok', label: 'OK', kind: 'primary' }], build, cancelLabel = 'Abbrechen', className = '' }) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'dlg ' + className });
    const body = el('div', { class: 'dlg-body' });
    if (title) body.append(el('h2', { class: 'dlg-title' }, title));
    if (text) for (const p of [].concat(text)) body.append(el('p', { class: 'dlg-text' }, p));
    let result = null;
    const close = (id) => { result = id; d.close(); };
    if (build) build(body, close);
    const bar = el('div', { class: 'dlg-buttons' });
    for (const b of buttons) bar.append(el('button', { class: 'btn ' + (b.kind || ''), type: 'button', onclick: () => close(b.id) }, b.label));
    if (cancelLabel) bar.append(el('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, cancelLabel));
    d.append(body, bar);
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    document.body.append(d);
    d.showModal();
  });
}

export async function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return (await dialog({ title, text, buttons: [{ id: 'ok', label: okLabel, kind: danger ? 'danger' : 'primary' }] })) === 'ok';
}

export function promptDialog({ title, label, value = '', okLabel = 'Sichern', extra }) {
  let input;
  return dialog({
    title,
    buttons: [{ id: 'ok', label: okLabel, kind: 'primary' }],
    build(body, close) {
      input = el('input', { class: 'field', type: 'text', value, 'aria-label': label || title, enterkeyhint: 'done' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close('ok'); } });
      if (label) body.append(el('label', { class: 'dlg-label' }, label));
      body.append(input);
      if (extra) extra(body);
      setTimeout(() => { input.focus(); input.select(); }, 50);
    },
  }).then((r) => (r === 'ok' ? input.value : null));
}

export function infoDialog(title, text) {
  return dialog({ title, text, buttons: [{ id: 'ok', label: 'OK', kind: 'primary' }], cancelLabel: null });
}

export function formatDate(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Gestern';
  if (now - d < 6 * 864e5) return d.toLocaleDateString('de-CH', { weekday: 'long' });
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
