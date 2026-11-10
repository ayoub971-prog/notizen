// Der Notiz-Editor: ein contenteditable-Bereich mit Formatierung,
// Checklisten, Tabellen und Anhangskarten.
// Formatierungen nutzen document.execCommand (in Chrome stabil vorhanden);
// dadurch funktioniert auch "Rueckgaengig" des Browsers.
import { sanitizeHtml } from './sanitize.js';

let editorEl = null;
let savedRange = null;

export function initEditor(el) {
  editorEl = el;
  document.execCommand('defaultParagraphSeparator', false, 'p');
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (sel.rangeCount && editorEl.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  });
}

/** Stellt die letzte Cursorposition im Editor wieder her (Knoepfe stehlen sonst den Fokus). */
export function restoreSelection() {
  const sel = document.getSelection();
  if (sel.rangeCount && editorEl.contains(sel.anchorNode)) { // Auswahl ist schon im Editor
    if (document.activeElement !== editorEl) editorEl.focus({ preventScroll: true });
    return;
  }
  if (savedRange && editorEl.contains(savedRange.startContainer)) {
    sel.removeAllRanges(); sel.addRange(savedRange);
  } else {
    const r = document.createRange();
    r.selectNodeContents(editorEl); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
  editorEl.focus({ preventScroll: true });
}

export function currentBlock() {
  const sel = document.getSelection();
  let n = sel.anchorNode;
  while (n && n !== editorEl) { if (n.nodeType === 1 && /^(P|H1|H2|H3|DIV|LI|PRE|BLOCKQUOTE)$/.test(n.tagName)) return n; n = n.parentNode; }
  return null;
}

export function closest(tag) {
  const sel = document.getSelection();
  let n = sel.anchorNode;
  while (n && n !== editorEl) { if (n.nodeType === 1 && n.matches(tag)) return n; n = n.parentNode; }
  return null;
}

/** Fuehrt einen Formatierungsbefehl aus. */
export function format(cmd, value) {
  restoreSelection();
  switch (cmd) {
    case 'title': document.execCommand('formatBlock', false, 'h1'); break;
    case 'heading': document.execCommand('formatBlock', false, 'h2'); break;
    case 'subheading': document.execCommand('formatBlock', false, 'h3'); break;
    case 'body': document.execCommand('formatBlock', false, 'p'); break;
    case 'bold': case 'italic': case 'underline': case 'strikeThrough':
    case 'insertUnorderedList': case 'insertOrderedList': case 'undo': case 'redo':
      document.execCommand(cmd); break;
    case 'color':
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('foreColor', false, value);
      document.execCommand('styleWithCSS', false, false);
      break;
    case 'size': setFontSize(value); break;
    case 'checklist': toggleChecklist(); break;
  }
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function setFontSize(px) {
  // Trick: fontSize 7 markieren, danach in <span style="font-size"> umwandeln
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  for (const f of editorEl.querySelectorAll('font[size="7"]')) {
    const s = document.createElement('span');
    if (px !== 'normal') s.style.fontSize = px;
    s.append(...f.childNodes);
    f.replaceWith(s);
  }
  // Ueberbleibsel von Chrome (span style="font-size: xxx-large") ersetzen
  for (const s of editorEl.querySelectorAll('span[style*="xxx-large"]')) { if (px === 'normal') s.style.removeProperty('font-size'); else s.style.fontSize = px; }
}

function toggleChecklist() {
  let ul = closest('ul');
  if (ul && ul.classList.contains('checklist')) { ul.classList.remove('checklist'); document.execCommand('insertUnorderedList'); return; }
  if (!ul) { document.execCommand('insertUnorderedList'); ul = closest('ul'); }
  if (ul) ul.classList.add('checklist');
}

/** Klick auf den Kreis links einer Checklisten-Zeile hakt sie ab. Gibt true zurueck, wenn umgeschaltet. */
export function handleChecklistClick(e) {
  const li = e.target.closest?.('ul.checklist > li');
  if (!li || !editorEl.contains(li)) return false;
  const rect = li.getBoundingClientRect();
  if (e.clientX - rect.left > 34) return false;
  e.preventDefault();
  if (li.getAttribute('data-checked') === 'true') li.removeAttribute('data-checked'); else li.setAttribute('data-checked', 'true');
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Fuegt HTML an der Cursorposition ein (bereinigt). */
export function insertHtml(html, { clean = true } = {}) {
  restoreSelection();
  const safe = clean ? sanitizeHtml(html) : html;
  const ok = document.execCommand('insertHTML', false, safe);
  if (!ok) {
    const sel = document.getSelection();
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const frag = r.createContextualFragment(safe);
    const last = frag.lastChild;
    r.insertNode(frag);
    if (last) { r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
  }
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- Tabellen ----------
export function insertTable(rows = 3, cols = 3) {
  // Bewusst ohne insertHTML: Chrome zerlegt Tabellen innerhalb von <p> sonst.
  restoreSelection();
  const table = document.createElement('table');
  table.className = 'note-table';
  const tbody = document.createElement('tbody');
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) { const cell = document.createElement(r === 0 ? 'th' : 'td'); cell.append(document.createElement('br')); tr.append(cell); }
    tbody.append(tr);
  }
  table.append(tbody);
  const after = document.createElement('p');
  after.append(document.createElement('br'));
  // oberster Block, in dem der Cursor steht
  let n = document.getSelection().anchorNode;
  while (n && n.parentNode !== editorEl) n = n.parentNode;
  if (!n || n === editorEl) editorEl.append(table, after);
  else if (n.nodeType === 1 && /^(P|DIV)$/.test(n.tagName) && !n.textContent.trim() && !n.querySelector('img,.att')) { n.replaceWith(table); table.after(after); }
  else { n.after(table); table.after(after); }
  placeCaret(table.querySelector('th'));
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function placeCaret(node) {
  if (!node) return;
  const r = document.createRange();
  r.selectNodeContents(node); r.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  editorEl.focus({ preventScroll: true });
}

export function currentCell() { return closest('td,th'); }

/** Tabellen-Aktionen: addRow, addCol, delRow, delCol, delTable */
export function tableAction(action) {
  restoreSelection();
  const cell = currentCell();
  if (!cell) return false;
  const row = cell.parentElement, table = cell.closest('table');
  const idx = [...row.children].indexOf(cell);
  const rows = [...table.querySelectorAll('tr')];
  if (action === 'addRow') {
    const nr = document.createElement('tr');
    for (let k = 0; k < row.children.length; k++) { const td = document.createElement('td'); td.innerHTML = '<br>'; nr.append(td); }
    row.after(nr); placeCaret(nr.children[Math.min(idx, nr.children.length - 1)]);
  } else if (action === 'addCol') {
    for (const r of rows) {
      const ref = r.children[Math.min(idx, r.children.length - 1)];
      const c = document.createElement(r.children[0]?.tagName === 'TH' ? 'th' : 'td'); c.innerHTML = '<br>';
      ref ? ref.after(c) : r.append(c);
    }
    placeCaret(row.children[idx + 1]);
  } else if (action === 'delRow') {
    if (rows.length <= 1) { table.remove(); } else { const next = row.nextElementSibling || row.previousElementSibling; row.remove(); placeCaret(next?.children[Math.min(idx, next.children.length - 1)]); }
  } else if (action === 'delCol') {
    if (row.children.length <= 1) { table.remove(); } else { for (const r of rows) r.children[idx]?.remove(); placeCaret(row.children[Math.max(0, idx - 1)]); }
  } else if (action === 'delTable') { table.remove(); }
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** HTML zum Speichern: Anhangskarten werden geleert (nur Platzhalter mit ID bleibt). */
export function serializeEditor() {
  const clone = editorEl.cloneNode(true);
  for (const a of clone.querySelectorAll('.att')) a.replaceChildren();
  return sanitizeHtml(clone.innerHTML);
}
