// Kleiner, toleranter HTML-Parser ohne Browser-Abhaengigkeit.
// Er wird von sanitize.js (Bereinigung beim Einfuegen) und blocks.js
// (Umwandlung fuer PDF/Text) benutzt und laeuft daher auch in Node-Tests.
//
// Ergebnis ist ein einfacher Baum:
//   { type: 'root', children: [...] }
//   { type: 'el', tag: 'p', attrs: { class: 'x' }, children: [...] }
//   { type: 'text', text: 'Hallo' }

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'col', 'wbr', 'source', 'area', 'base', 'embed', 'param', 'track']);
// Inhalt dieser Elemente wird nie als HTML gelesen (Skripte, Stile ...).
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes']);
// Elemente, die ein offenes <p>/<li> automatisch schliessen.
const BLOCKS = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'section', 'article', 'header', 'footer']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â',
  aacute: 'á', ccedil: 'ç', iacute: 'í', oacute: 'ó', uacute: 'ú', Eacute: 'É', Egrave: 'È', Agrave: 'À',
  euro: '€', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', bdquo: '„', sbquo: '‚', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', deg: '°',
  times: '×', divide: '÷', shy: '\u00ad', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '', frac12: '½',
  frac14: '¼', frac34: '¾', sect: '§', para: '¶', plusmn: '±', micro: 'µ', pound: '£', yen: '¥', cent: '¢'
};

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
}
export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseHtml(html) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const s = String(html ?? '');
  let i = 0;
  const pushText = (t) => { if (t) top().children.push({ type: 'text', text: decodeEntities(t) }); };
  const closeTo = (tag) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) { stack.length = k; return true; }
    }
    return false;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { pushText(s.slice(i)); break; }
    pushText(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3; continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') { // Doctype, CDATA, Processing instructions
      const end = s.indexOf('>', lt);
      i = end < 0 ? s.length : end + 1; continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(s.slice(lt, lt + 20000));
    if (!m) { pushText('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) { // Endtag
      if (tag === 'br') top().children.push({ type: 'el', tag: 'br', attrs: {}, children: [] });
      else closeTo(tag);
      continue;
    }
    if (BLOCKS.has(tag) && top().tag === 'p') stack.pop();
    if (tag === 'li') { for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tag === 'li') { stack.length = k; break; } if (stack[k].tag === 'ul' || stack[k].tag === 'ol') break; } }
    if (tag === 'tr') { for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tag === 'tr') { stack.length = k; break; } if (stack[k].tag === 'table') break; } }
    if (tag === 'td' || tag === 'th') { for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tag === 'td' || stack[k].tag === 'th') { stack.length = k; break; } if (stack[k].tag === 'tr' || stack[k].tag === 'table') break; } }
    const node = { type: 'el', tag, attrs: parseAttrs(m[3]), children: [] };
    top().children.push(node);
    if (RAW.has(tag)) {
      const end = s.toLowerCase().indexOf('</' + tag, i);
      const raw = end < 0 ? s.slice(i) : s.slice(i, end);
      node.children.push({ type: 'text', text: raw, raw: true });
      if (end < 0) i = s.length; else { const gt = s.indexOf('>', end); i = gt < 0 ? s.length : gt + 1; }
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
  }
  return root;
}

export function serialize(node) {
  if (node.type === 'text') return escapeText(node.text);
  const inner = node.children.map(serialize).join('');
  if (node.type === 'root') return inner;
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

export function textContent(node) {
  if (node.type === 'text') return node.raw ? '' : node.text;
  return node.children.map(textContent).join('');
}
