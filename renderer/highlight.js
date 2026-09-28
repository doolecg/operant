// Syntax colours for the viewer tile and Markdown code blocks. A small tokenizer per language family
// (comments, strings, numbers, keywords, types, function names); good enough to read code by, and
// everything is escaped, so a file can't inject markup.

const Highlight = (() => {
  const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const words = s => new Set(s.split(' '));

  const C_LIKE = 'if else for while do switch case default break continue return goto try catch finally throw new delete this super class struct enum union interface extends implements public private protected static final abstract const volatile void import package export from as typeof instanceof in of let var function async await yield true false null undefined sizeof using namespace virtual override template typename operator friend inline extern register signed unsigned auto char short int long float double bool boolean byte string var val fun object data when is where impl trait pub mod use crate self Self mut ref match loop move dyn unsafe fn go chan select defer range func map type struct nil record sealed permits throws native synchronized transient strictfp assert lateinit companion internal open suspend readonly declare keyof never unknown any number symbol bigint';
  const LANGS = {
    c: { line: ['//'], block: [['/*', '*/']], str: '"\'`', kw: words(C_LIKE) },
    py: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], str: '"\'', kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self match case print') },
    sh: { line: ['#'], block: [['<#', '#>']], str: '"\'', kw: words('if then else elif fi for while do done case esac in function return local export echo exit break continue until select param begin process end foreach switch try catch finally throw trap Write-Host Get-Command -eq -ne -lt -gt -le -ge -and -or -not') },
    conf: { line: ['#', ';'], block: [], str: '"\'', kw: words('true false yes no on off null') },
    css: { line: [], block: [['/*', '*/']], str: '"\'', kw: words('important media import from to and not only supports keyframes font-face') },
    sql: { line: ['--'], block: [['/*', '*/']], str: '\'"', kw: words('select from where and or not insert into values update set delete create table index view drop alter join left right inner outer on group by order having limit as distinct union all null is in like between case when then else end primary key foreign references default') },
    lua: { line: ['--'], block: [['--[[', ']]']], str: '"\'', kw: words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while') },
  };
  const EXT = {
    js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c', mts: 'c', json: 'c', jsonc: 'c', java: 'c', kt: 'c', kts: 'c', groovy: 'c', gradle: 'c', scala: 'c',
    c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cxx: 'c', cs: 'c', go: 'c', rs: 'c', swift: 'c', dart: 'c', php: 'c', zig: 'c', v: 'c', proto: 'c',
    py: 'py', pyw: 'py', rb: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh', psm1: 'sh', bat: 'conf', cmd: 'conf',
    yaml: 'conf', yml: 'conf', toml: 'conf', ini: 'conf', cfg: 'conf', conf: 'conf', properties: 'conf', env: 'conf', mcmeta: 'c',
    css: 'css', scss: 'css', less: 'css', sql: 'sql', lua: 'lua',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', xaml: 'xml', csproj: 'xml', plist: 'xml',
    javascript: 'c', typescript: 'c', python: 'py', shell: 'sh', powershell: 'sh', console: 'sh', rust: 'c', kotlin: 'c', csharp: 'c', golang: 'c',
  };
  // A file name, an extension or a Markdown fence's language -> a language, or null.
  const lang = name => {
    const n = String(name || '').toLowerCase(), ext = n.includes('.') ? n.split('.').pop() : n;
    if (/(^|[\\/])(dockerfile|makefile)$/.test(n)) return 'sh';
    return EXT[ext] || null;
  };

  const span = (cls, t) => cls ? `<span class="hl-${cls}">${esc(t)}</span>` : esc(t);

  function tokensXml(src) {
    const out = [];
    const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?)([\w:.-]+)|("[^"]*"|'[^']*')|([\w:.-]+)(?==)|(\/?>)|([^<"'\w/>]+|[\s\S])/g;
    let inTag = false, m;
    while ((m = re.exec(src))) {
      if (m[1]) out.push(['c', m[1]]);
      else if (m[2]) { out.push(['p', m[2]]); out.push(['k', m[3]]); inTag = true; }
      else if (m[4] && inTag) out.push(['s', m[4]]);
      else if (m[5] && inTag) out.push(['t', m[5]]);
      else if (m[6] && inTag) { out.push(['p', m[6]]); inTag = false; }
      else out.push([null, m[0]]);
    }
    return out;
  }

  function tokens(src, l) {
    if (l === 'xml') return tokensXml(src);
    const L = LANGS[l], out = [];
    let i = 0, plain = '';
    const push = (cls, t) => { if (plain) { out.push([null, plain]); plain = ''; } out.push([cls, t]); };
    const at = s => src.startsWith(s, i);
    while (i < src.length) {
      const ch = src[i];
      let b = L.block.find(([o]) => at(o)), ln;
      if (b) { const e = src.indexOf(b[1], i + b[0].length), j = e < 0 ? src.length : e + b[1].length; push(b[0] === '"""' || b[0] === "'''" ? 's' : 'c', src.slice(i, j)); i = j; continue; }
      if ((ln = L.line.find(s => at(s))) && (ln !== '#' || l !== 'css')) {
        // '#' only starts a comment at the start of a word (not in $# or a colour).
        if (!(ln === '#' && i > 0 && /[\w$]/.test(src[i - 1]))) { const e = src.indexOf('\n', i), j = e < 0 ? src.length : e; push('c', src.slice(i, j)); i = j; continue; }
      }
      if (L.str.includes(ch)) {
        let j = i + 1;
        while (j < src.length && src[j] !== ch && (src[j] !== '\n' || ch === '`')) j += src[j] === '\\' ? 2 : 1;
        push('s', src.slice(i, j + 1)); i = j + 1; continue;
      }
      if (/[0-9]/.test(ch) && !/[\w$]/.test(src[i - 1] || '')) {
        const m = /^(0x[\da-f_]+|0b[01_]+|[\d_]*\.?[\d_]+(e[+-]?\d+)?)[a-z]*/i.exec(src.slice(i, i + 40));
        push('n', m[0]); i += m[0].length; continue;
      }
      if (/[A-Za-z_$@-]/.test(ch)) {
        const m = /^[@$]?[A-Za-z_][\w$-]*/.exec(src.slice(i, i + 200)) || /^[@$-]/.exec(src.slice(i));
        let w = m[0];
        if (w.includes('-') && l !== 'sh' && l !== 'css') w = w.split('-')[0] || '-';
        const next = src.slice(i + w.length).match(/^\s*(.)/)?.[1];
        const cls = L.kw.has(w) ? 'k' : next === '(' ? 'f' : /^[A-Z][a-z]/.test(w) ? 't' : w[0] === '@' ? 'k' : null;
        if (cls) push(cls, w); else plain += w;
        i += w.length; continue;
      }
      plain += ch; i++;
    }
    if (plain) out.push([null, plain]);
    return out;
  }

  // The source as one HTML string per line, spans closed and reopened at each line break.
  function lines(src, l) {
    src = String(src).replace(/\r/g, '');
    const res = [''];
    for (const [cls, t] of tokens(src, l)) {
      const parts = t.split('\n');
      parts.forEach((p, k) => { if (k) res.push(''); if (p) res[res.length - 1] += span(cls, p); });
    }
    return res;
  }

  return { lang, lines };
})();
