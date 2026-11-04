'use strict';
// Shared helpers: escaping, safe markdown, code cards with tiny syntax highlighting.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => /^https?:\/\//i.test(u) ? u : '#';

// ---------- syntax highlighting (python, powershell, bash, js/ts) ----------
const LANG_ALIAS = { py: 'python', python: 'python', python3: 'python', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', powershell: 'powershell',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', json: 'json' };
const LANG_LABEL = { python: 'Python', powershell: 'PowerShell', bash: 'Bash', js: 'JavaScript', json: 'JSON', ts: 'TypeScript', typescript: 'TypeScript' };
const words = (s) => new Set(s.split(' '));
const BT = '`';
const HL = {
  python: {
    re: String.raw`(?<c>#.*)|(?<s>[rRbBfFuU]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))|(?<n>\b\d[\d_]*(?:\.\d+)?\b)|(?<w>[A-Za-z_]\w*)`,
    kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
    lit: words('True False None self'),
    bi: words('print input len range int str float list dict set tuple open enumerate zip sorted sum min max abs type isinstance round map filter any all super'),
  },
  powershell: {
    re: String.raw`(?<o>^PS [^>\n]*>)|(?<c><#[\s\S]*?#>|#.*)|(?<s>"[^"\n]*"|'[^'\n]*')|(?<v>\$[\w:]+)|(?<p>-[A-Za-z][\w-]*)|(?<x>\||;|&&|\n)|(?<n>\b\d+(?:\.\d+)?\b)|(?<w>[A-Za-z_][\w.-]*)`,
    kw: words('if else elseif foreach for while do switch function return param in break continue try catch finally'),
    lit: words('$true $false $null'),
  },
  bash: {
    re: String.raw`(?<o>^\$ )|(?<c>#.*)|(?<s>"(?:\\.|[^"\\])*"|'[^']*')|(?<v>\$\{?\w+\}?)|(?<p>--?[A-Za-z][\w-]*)|(?<x>\||;|&&|\n)|(?<n>\b\d+(?:\.\d+)?\b)|(?<w>[A-Za-z_][\w.-]*)`,
    kw: words('if then else elif fi for in do done while case esac function return export local'),
    lit: words('true false'),
  },
  js: {
    re: String.raw`(?<c>\/\/.*|\/\*[\s\S]*?\*\/)|(?<s>` + BT + String.raw`(?:\\.|[^\\` + BT + String.raw`])*` + BT + String.raw`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<n>\b\d+(?:\.\d+)?\b)|(?<w>[A-Za-z_$][\w$]*)`,
    kw: words('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof of in type interface'),
    lit: words('true false null undefined this'),
    bi: words('console fetch Promise JSON Math Object Array String Number document window'),
  },
  json: { re: String.raw`(?<s>"(?:\\.|[^"\\])*")|(?<n>-?\b\d+(?:\.\d+)?\b)|(?<w>true|false|null)`, kw: new Set(), lit: words('true false null') },
};
function highlight(code, lang) {
  const L = HL[LANG_ALIAS[(lang || '').toLowerCase()]];
  if (!L) return esc(code);
  const re = new RegExp(L.re, 'gm');
  const shell = L.re.includes('(?<x>');
  const transcript = shell && /^(PS [^>\n]*>|\$ )/m.test(code); // output lines stay plain
  let out = '', last = 0, cmd = true, onPrompt = false, m;
  const span = (cls, t) => `<span class="t-${cls}">${esc(t)}</span>`;
  while ((m = re.exec(code))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(code.slice(last, m.index)); last = re.lastIndex;
    const g = m.groups, t = m[0];
    if (g.o) { out += span('o', t); cmd = true; onPrompt = true; continue; }
    if (g.x) { out += esc(t); if (t === '\n') onPrompt = false; cmd = !transcript || onPrompt; continue; }
    if (transcript && !onPrompt) { out += esc(t); continue; }
    if (g.c) out += span('c', t);
    else if (g.s) out += span('s', t);
    else if (g.v) out += span(L.lit.has(t.toLowerCase()) ? 'n' : 'v', t);
    else if (g.p) { const prev = code[m.index - 1]; out += (prev === undefined || /\s/.test(prev)) ? span('p', t) : esc(t); }
    else if (g.n) out += span('n', t);
    else if (g.w) {
      if (L.kw.has(t)) out += span('k', t);
      else if (L.lit.has(t)) out += span('n', t);
      else if (shell && cmd) out += span('f', t);
      else if (shell && /^[A-Z][a-z]+-[A-Z]\w+$/.test(t)) out += span('f', t);
      else if (!shell && ((L.bi && L.bi.has(t)) || code[re.lastIndex] === '(')) out += span('f', t);
      else out += esc(t);
    }
    cmd = false;
  }
  return out + esc(code.slice(last));
}
function codeCard(code, lang) {
  const key = LANG_ALIAS[(lang || '').toLowerCase()];
  const label = LANG_LABEL[(lang || '').toLowerCase()] || LANG_LABEL[key] || (lang || 'Code');
  return `<div class="code"><div class="code-h"><span class="code-l">${esc(label)}</span>` +
    `<button class="copy" type="button" aria-label="Copy code"><svg><use href="#i-copy"/></svg><span>Copy</span></button></div>` +
    `<pre><code>${highlight(code, lang)}</code></pre></div>`;
}
// Copy text: for prompt-style shell transcripts, copy only the commands.
function codeText(card) {
  const raw = card.querySelector('pre').textContent;
  const lines = raw.split('\n');
  const prompt = /^(PS [^>\n]*>\s?|\$ )/;
  if (lines.some(l => prompt.test(l))) return lines.filter(l => prompt.test(l)).map(l => l.replace(prompt, '')).filter(l => l.trim()).join('\n');
  return raw;
}

// ---------- safe markdown ----------
// Works on raw text; every piece of text is escaped before it becomes HTML.
function inline(src) {
  const slots = [];
  const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => put(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>]*[^\s<>.,;:!?)'"])/g, (_, pre, u) => pre + put(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a>`));
  s = esc(s)
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^~]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

const RE = {
  fence: /^\s*(```|~~~)\s*([\w+-]*)\s*$/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  heading: /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/,
  quote: /^\s{0,3}>\s?/,
  item: /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};
const indentOf = (s) => s.replace(/\t/g, '    ').match(/^ */)[0].length;
const isBlockStart = (l, next) => RE.fence.test(l) || RE.hr.test(l) || RE.heading.test(l) || RE.quote.test(l) || RE.item.test(l) || (l.includes('|') && next !== undefined && RE.tableSep.test(next));

// "Steps: 1) a, 2) b, 3) c. More text"  ->  intro, [a, b, c], outro
function inlineEnum(text) {
  const first = text.search(/(^|\s)1\)\s+\S/);
  if (first < 0) return null;
  const marks = [];
  let n = 1, from = first;
  for (;;) {
    const re = new RegExp(`(^|[\\s,;])(?:and\\s+|or\\s+)?${n}\\)\\s+`, 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) break;
    marks.push({ at: m.index + m[1].length, body: m.index + m[0].length });
    from = m.index + m[0].length; n++;
  }
  if (marks.length < 2) return null;
  const items = [];
  for (let i = 0; i < marks.length; i++) items.push(text.slice(marks[i].body, i + 1 < marks.length ? marks[i + 1].at : undefined));
  let outro = '';
  const last = items[items.length - 1];
  const stop = last.search(/[.!?](\s+|$)/);
  if (stop >= 0) { outro = last.slice(stop + 1).trim(); items[items.length - 1] = last.slice(0, stop); }
  const clean = items.map(t => t.trim().replace(/[,;]\s*(and|or)?\s*$/i, '').replace(/\s+(and|or)$/i, '').trim()).filter(Boolean);
  return { intro: text.slice(0, first).trim(), items: clean, outro };
}

function paragraph(lines) {
  const text = lines.map(l => l.trim()).join('\n');
  const en = inlineEnum(text.replace(/\n/g, ' '));
  if (en) {
    return (en.intro ? `<p>${inline(en.intro)}</p>` : '') +
      `<ol>${en.items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>` +
      (en.outro ? paragraph([en.outro]) : '');
  }
  return `<p>${text.split('\n').map(inline).join('<br>')}</p>`;
}

function list(items) {
  let i = 0;
  const rec = () => {
    const base = items[i].indent, ordered = items[i].ordered;
    const startNum = ordered && items[i].num !== 1 ? ` start="${items[i].num}"` : '';
    let html = ordered ? `<ol${startNum}>` : '<ul>';
    let open = false;
    while (i < items.length && items[i].indent >= base) {
      if (items[i].indent > base) { html += rec(); continue; }
      if (items[i].ordered !== ordered) break;
      if (open) html += '</li>';
      html += `<li>${items[i].text.map(inline).join('<br>')}`; open = true; i++;
    }
    if (open) html += '</li>';
    return html + (ordered ? '</ol>' : '</ul>');
  };
  let out = '';
  while (i < items.length) out += rec();
  return out;
}

function table(rows) {
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const head = cells(rows[0]);
  const aligns = cells(rows[1]).map(c => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : '');
  const td = (tag, c, j) => `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ''}>${inline(c)}</${tag}>`;
  return `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>` +
    rows.slice(2).map(r => `<tr>${cells(r).map((c, j) => td('td', c, j)).join('')}</tr>`).join('') + '</tbody></table></div>';
}

function md(src) {
  const L = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0, out = '';
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(RE.fence))) {
      const fence = m[1], lang = m[2]; const code = []; i++;
      while (i < L.length && !L[i].trim().startsWith(fence)) code.push(L[i++]);
      i++;
      out += codeCard(code.join('\n'), lang);
      continue;
    }
    if (RE.hr.test(l)) { out += '<hr>'; i++; continue; }
    if ((m = l.match(RE.heading))) {
      const lvl = m[1].length, tag = lvl <= 2 ? 'h2' : lvl === 3 ? 'h3' : 'h4';
      out += `<${tag}>${inline(m[2])}</${tag}>`; i++; continue;
    }
    if (RE.quote.test(l)) {
      const q = [];
      while (i < L.length && L[i].trim() && (RE.quote.test(L[i]) || !isBlockStart(L[i]))) q.push(L[i++].replace(RE.quote, ''));
      out += `<blockquote>${md(q.join('\n'))}</blockquote>`; continue;
    }
    if (l.includes('|') && i + 1 < L.length && RE.tableSep.test(L[i + 1])) {
      const rows = [L[i], L[i + 1]]; i += 2;
      while (i < L.length && L[i].includes('|') && L[i].trim()) rows.push(L[i++]);
      out += table(rows); continue;
    }
    if (RE.item.test(l)) {
      const items = [];
      while (i < L.length) {
        const cur = L[i];
        const im = cur.match(RE.item);
        if (im) {
          const marker = im[2];
          items.push({ indent: indentOf(im[1]), ordered: /\d/.test(marker), num: parseInt(marker, 10) || 1, text: [im[3]] });
          i++; continue;
        }
        if (!cur.trim()) { // blank: list continues only if the next non-blank line is an item or indented
          let j = i; while (j < L.length && !L[j].trim()) j++;
          if (j < L.length && (RE.item.test(L[j]) && indentOf(L[j]) >= items[0].indent || indentOf(L[j]) >= 2) ) { i = j; continue; }
          break;
        }
        if (isBlockStart(cur, L[i + 1]) && !(indentOf(cur) >= 2 && !RE.item.test(cur))) break;
        items[items.length - 1].text.push(cur.trim()); i++; // continuation line
      }
      out += list(items); continue;
    }
    const para = [];
    while (i < L.length && L[i].trim() && !(para.length && isBlockStart(L[i], L[i + 1]))) para.push(L[i++]);
    out += paragraph(para);
  }
  return out;
}
const plain = (s) => (s || '').replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`~|]/g, '').replace(/\s+/g, ' ').trim();

