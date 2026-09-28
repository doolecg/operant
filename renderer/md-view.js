// Markdown to HTML for the file viewer tile: headings, paragraphs, lists (nested, numbered, task
// lists), quotes, fenced code, tables, rules, and inline code, bold, italic, strikethrough, links and
// images. Everything is escaped first, so a file can't inject markup.

const MdView = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function inline(text) {
    const codes = [];
    let t = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = t
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => `<a href="#" data-href="${src}" class="md-img">🖼 ${alt || src}</a>`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="#" data-href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="#" data-href="$2">$2</a>')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<b>${a || b}</b>`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  function render(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    let html = '', para = [];
    const lists = []; // open lists: { tag, indent }
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
    const closeLists = (toIndent = -1) => {
      while (lists.length && lists.at(-1).indent > toIndent) html += `</li></${lists.pop().tag}>`;
    };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
        flushPara(); closeLists();
        const fence = m[1], body = [];
        while (++i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i]);
        html += `<pre class="md-code"${m[2] ? ` data-lang="${esc(m[2])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`;
      } else if (!line.trim()) {
        flushPara();
        if (lists.length && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] || '') && !/^\s{2,}\S/.test(lines[i + 1] || '')) closeLists();
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeLists(); html += '<hr>'; }
      else if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
        flushPara(); closeLists();
        const id = m[2].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
        html += `<h${m[1].length} id="${esc(id)}">${inline(m[2])}</h${m[1].length}>`;
      } else if (/^\s*>/.test(line)) {
        flushPara(); closeLists();
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i--;
        html += `<blockquote>${render(quote.join('\n'))}</blockquote>`;
      } else if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
        flushPara(); closeLists();
        const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
        html += `<table><thead><tr>${cells(line).map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`;
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) html += `<tr>${cells(lines[i]).map((c, k) => td('td', c, k)).join('')}</tr>`;
        i--;
        html += '</tbody></table>';
      } else if ((m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        flushPara();
        const indent = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (lists.length && lists.at(-1).indent > indent) html += `</li></${lists.pop().tag}>`;
        const top = lists.at(-1);
        if (top && top.indent === indent && top.tag !== tag) { html += `</li></${lists.pop().tag}>`; }
        if (!lists.length || lists.at(-1).indent < indent) {
          const start = tag === 'ol' && parseInt(m[2]) !== 1 ? ` start="${parseInt(m[2])}"` : '';
          html += `<${tag}${start}>`; lists.push({ tag, indent });
        } else html += '</li>';
        const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        html += task ? `<li class="task"><span class="box${task[1] === ' ' ? '' : ' done'}"></span>${inline(task[2])}` : `<li>${inline(m[3])}`;
      } else if (lists.length && /^\s+\S/.test(raw)) html += ' ' + inline(line.trim());
      else { closeLists(); para.push(line.trim()); }
    }
    flushPara(); closeLists();
    return html;
  }

  return { render, esc };
})();
