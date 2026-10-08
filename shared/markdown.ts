// A small, safe Markdown parser. It builds a plain tree (no HTML anywhere), so the renderer can turn it into React
// elements and everything stays escaped. Raw HTML is just text. Work is bounded: input, nesting and inline scanning
// all have caps, so a hostile outcome cannot hang the UI.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  // null: a normal item; true/false: a task item that is ticked or not.
  task: boolean | null
  blocks: Block[]
}

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

export const MARKDOWN_MAX_CHARS = 400_000
const MAX_DEPTH = 8
const INLINE_BUDGET = 400_000
const MAX_TABLE_COLS = 40

const SAFE_LINK = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i

// The href when it is an http, https or mailto link; otherwise null (javascript:, data:, relative, file: ...).
export function safeHref(raw: string): string | null {
  const url = raw.trim().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
  return SAFE_LINK.test(url) && !/[<>"]/.test(url) ? url : null
}

// Inline

interface Ctx {
  budget: number
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/
const AUTOLINK = /^https?:\/\/[^\s<>]+/i

function trimUrlEnd(url: string): string {
  let u = url
  for (;;) {
    const last = u[u.length - 1]
    if (last && '.,;:!?\'"*_~'.includes(last)) u = u.slice(0, -1)
    else if (last === ')' && (u.match(/\)/g)?.length ?? 0) > (u.match(/\(/g)?.length ?? 0)) u = u.slice(0, -1)
    else if (last === ']' && (u.match(/]/g)?.length ?? 0) > (u.match(/\[/g)?.length ?? 0)) u = u.slice(0, -1)
    else return u
  }
}

// The index of the `]` that closes the `[` at `from`, or -1.
function closeBracket(s: string, from: number, ctx: Ctx): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    ctx.budget--
    if (ctx.budget < 0) return -1
    const ch = s[i]
    if (ch === '\\') i++
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return i
  }
  return -1
}

// `(url "title")` starting at `from` (the `(`): the url and the index after `)`.
function linkTarget(s: string, from: number): { url: string; end: number } | null {
  let i = from + 1
  while (s[i] === ' ') i++
  let url = ''
  if (s[i] === '<') {
    const close = s.indexOf('>', i)
    if (close < 0 || s.slice(i, close).includes('\n')) return null
    url = s.slice(i + 1, close)
    i = close + 1
  } else {
    let depth = 0
    const start = i
    for (; i < s.length; i++) {
      const ch = s[i]!
      if (ch === '(') depth++
      else if (ch === ')') {
        if (depth === 0) break
        depth--
      } else if (/\s/.test(ch)) break
    }
    url = s.slice(start, i)
  }
  while (s[i] === ' ') i++
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i]!
    const close = s.indexOf(q, i + 1)
    if (close < 0) return null
    i = close + 1
    while (s[i] === ' ') i++
  }
  return s[i] === ')' ? { url, end: i + 1 } : null
}

function flush(out: Inline[], buf: string): string {
  if (buf) {
    const last = out[out.length - 1]
    if (last?.t === 'text') last.v += buf
    else out.push({ t: 'text', v: buf })
  }
  return ''
}

const isAlnum = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch)

function parseInline(src: string, depth: number, ctx: Ctx): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0
  const n = src.length

  // A delimited run (`**x**`): the inner nodes and the index after the closer, or null when it never closes.
  const wrapped = (delim: string, kind: 'strong' | 'em' | 'del', intraword: boolean): boolean => {
    if (depth >= MAX_DEPTH) return false
    const after = src[i + delim.length]
    if (!after || /\s/.test(after) || after === delim[0]) return false
    if (!intraword && isAlnum(src[i - 1])) return false
    let from = i + delim.length
    for (;;) {
      const close = src.indexOf(delim, from)
      ctx.budget -= (close < 0 ? n : close) - from + 1
      if (close < 0 || ctx.budget < 0) return false
      const before = src[close - 1]!
      const next = src[close + delim.length]
      if (close > i + delim.length && !/\s/.test(before) && next !== delim[0] && (intraword || !isAlnum(next))) {
        flush(out, buf)
        buf = ''
        out.push({ t: kind, c: parseInline(src.slice(i + delim.length, close), depth + 1, ctx) })
        i = close + delim.length
        return true
      }
      from = close + 1
    }
  }

  while (i < n) {
    if (ctx.budget < 0) {
      buf += src.slice(i)
      break
    }
    ctx.budget--
    const ch = src[i]!
    if (ch === '\\') {
      const next = src[i + 1]
      if (next === '\n') {
        buf = flush(out, buf)
        out.push({ t: 'br' })
        i += 2
      } else if (next && ESCAPABLE.test(next)) {
        buf += next
        i += 2
      } else {
        buf += ch
        i++
      }
    } else if (ch === '\n') {
      buf = flush(out, buf.replace(/ +$/, ''))
      out.push({ t: 'br' })
      i++
    } else if (ch === '`') {
      let run = 1
      while (src[i + run] === '`') run++
      const fence = '`'.repeat(run)
      let close = src.indexOf(fence, i + run)
      while (close >= 0 && src[close + run] === '`') {
        let k = close
        while (src[k] === '`') k++
        close = src.indexOf(fence, k)
      }
      ctx.budget -= (close < 0 ? n : close) - i
      if (close < 0) {
        buf += fence
        i += run
      } else {
        buf = flush(out, buf)
        let v = src.slice(i + run, close).replace(/\n/g, ' ')
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
        out.push({ t: 'code', v })
        i = close + run
      }
    } else if ((ch === '*' && src[i + 1] === '*') || (ch === '_' && src[i + 1] === '_')) {
      if (!wrapped(ch + ch, 'strong', ch === '*')) {
        buf += ch + ch
        i += 2
      }
    } else if (ch === '*' || ch === '_') {
      if (!wrapped(ch, 'em', ch === '*')) {
        buf += ch
        i++
      }
    } else if (ch === '~' && src[i + 1] === '~') {
      if (!wrapped('~~', 'del', true)) {
        buf += '~~'
        i += 2
      }
    } else if ((ch === '[' || (ch === '!' && src[i + 1] === '[')) && depth < MAX_DEPTH) {
      const image = ch === '!'
      const open = image ? i + 1 : i
      const close = closeBracket(src, open, ctx)
      const target = close > 0 && src[close + 1] === '(' ? linkTarget(src, close + 1) : null
      if (close < 0 || !target) {
        buf += ch
        i++
        continue
      }
      const label = src.slice(open + 1, close)
      const href = safeHref(target.url)
      buf = flush(out, buf)
      // Images are never loaded: the alt text, as a link when the address is safe.
      const inner = image ? [{ t: 'text', v: label || target.url } as Inline] : parseInline(label, depth + 1, ctx)
      if (href) out.push({ t: 'link', href, c: inner.length ? inner : [{ t: 'text', v: href }] })
      else out.push(...inner)
      i = target.end
    } else if (ch === '<' && /^<(?:https?:\/\/|mailto:)[^\s<>]+>/i.test(src.slice(i, i + 2048))) {
      const close = src.indexOf('>', i)
      const href = safeHref(src.slice(i + 1, close))
      buf = flush(out, buf)
      if (href) out.push({ t: 'link', href, c: [{ t: 'text', v: href }] })
      i = close + 1
    } else if ((ch === 'h' || ch === 'H') && !isAlnum(src[i - 1]) && AUTOLINK.test(src.slice(i, i + 2048))) {
      const url = trimUrlEnd(AUTOLINK.exec(src.slice(i, i + 2048))![0])
      const href = safeHref(url)
      if (href && url.length > 8) {
        buf = flush(out, buf)
        out.push({ t: 'link', href, c: [{ t: 'text', v: url }] })
        i += url.length
      } else {
        buf += ch
        i++
      }
    } else {
      buf += ch
      i++
    }
  }
  flush(out, buf)
  return out
}

// Blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ ]?(.*)$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/
const TASK = /^\[([ xX])\][ \t]+(.*)$/s
const DELIM_CELL = /^:?-+:?$/

const indentOf = (line: string): number => /^ */.exec(line)![0].length
const isBlank = (line: string): boolean => line.trim() === ''

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

function tableDelim(line: string | undefined): Align[] | null {
  if (line === undefined || !line.includes('-') || !/^[\s|:-]+$/.test(line)) return null
  const cells = splitRow(line)
  if (!cells.every((c) => DELIM_CELL.test(c))) return null
  return cells.map((c) => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null))
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)
}

function parseBlocks(lines: string[], depth: number, ctx: Ctx): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }
    if (depth >= MAX_DEPTH) {
      out.push({ t: 'p', c: [{ t: 'text', v: lines.slice(i).join('\n') }] })
      break
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]!
      const indent = indentOf(line)
      const body: string[] = []
      i++
      while (i < lines.length) {
        const l = lines[i]!.trim()
        if (l.length >= mark.length && l.split(mark[0]!).join('') === '' && l.startsWith(mark)) break
        body.push(lines[i]!.slice(Math.min(indent, indentOf(lines[i]!))))
        i++
      }
      i++
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }

    const hr = HR.test(line)
    if (hr) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: 'heading', level: heading[1]!.length, c: parseInline(heading[2] ?? '', 0, ctx) })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!)
        if (m) inner.push(m[1]!)
        else if (!isBlank(lines[i]!) && !startsBlock(lines[i]!) && inner.length && !isBlank(inner[inner.length - 1]!)) inner.push(lines[i]!)
        else break
        i++
      }
      out.push({ t: 'quote', c: parseBlocks(inner, depth + 1, ctx) })
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      const base = item[1]!.length
      const ordered = /\d/.test(item[2]!)
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1
      const items: ListItem[] = []
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!)
        if (!m || m[1]!.length > base + 1 || /\d/.test(m[2]!) !== ordered || (HR.test(lines[i]!) && !ordered)) break
        const contentIndent = m[1]!.length + m[2]!.length + 1
        const body: string[] = [m[3] ?? '']
        i++
        while (i < lines.length) {
          const l = lines[i]!
          if (isBlank(l)) {
            // A blank line stays in the item only when the next non-blank line is indented under it.
            let k = i + 1
            while (k < lines.length && isBlank(lines[k]!)) k++
            if (k < lines.length && indentOf(lines[k]!) > base + 1) {
              body.push('')
              i++
              continue
            }
            break
          }
          const ind = indentOf(l)
          if (ind > base + 1) body.push(l.slice(Math.min(ind, contentIndent)))
          else if (!startsBlock(l) && !isBlank(body[body.length - 1]!)) body.push(l.trim())
          else break
          i++
        }
        let task: boolean | null = null
        const first = TASK.exec(body[0]!)
        if (first) {
          task = first[1] !== ' '
          body[0] = first[2]!
        }
        items.push({ task, blocks: parseBlocks(body, depth + 1, ctx) })
        if (items.length > 5000) break
      }
      out.push({ t: 'list', ordered, start, items })
      continue
    }

    const align = line.includes('|') ? tableDelim(lines[i + 1]) : null
    if (align) {
      const head = splitRow(line)
      if (head.length === align.length && head.length <= MAX_TABLE_COLS) {
        const rows: Inline[][][] = []
        i += 2
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
          const cells = splitRow(lines[i]!)
          rows.push(align.map((_, k) => parseInline(cells[k] ?? '', 1, ctx)))
          i++
        }
        out.push({ t: 'table', align, head: head.map((c) => parseInline(c, 1, ctx)), rows })
        continue
      }
    }

    // A paragraph runs to a blank line or the next block start.
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!) && !(lines[i]!.includes('|') && tableDelim(lines[i + 1]))) {
      para.push(lines[i]!.trim())
      i++
    }
    out.push({ t: 'p', c: parseInline(para.join('\n'), 0, ctx) })
  }
  return out
}

export function parseMarkdown(src: string): Block[] {
  const text = (src.length > MARKDOWN_MAX_CHARS ? src.slice(0, MARKDOWN_MAX_CHARS) : src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  return parseBlocks(text.split('\n'), 0, { budget: INLINE_BUDGET })
}

// Plain text

export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : inlineText(n.c)))
    .join('')
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'heading':
    case 'p':
      return inlineText(b.c)
    case 'code':
      return b.v
    case 'quote':
      return b.c.map(blockText).join(' ')
    case 'list':
      return b.items.map((it) => it.blocks.map(blockText).join(' ')).join(' ')
    case 'table':
      return [b.head, ...b.rows].map((r) => r.map(inlineText).join(' ')).join(' ')
    case 'hr':
      return ''
  }
}

// Markdown stripped to one line of plain text, cut at `max` characters (for cards and previews).
export function markdownToPlain(src: string, max = 200): string {
  const head = src.length > max * 8 ? src.slice(0, max * 8) : src
  const text = parseBlocks(head.replace(/\r\n?/g, '\n').split('\n'), 0, { budget: 50_000 })
    .map(blockText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export interface MdSection {
  // The heading that opens the section; null for the blocks before the first heading.
  heading: Block | null
  blocks: Block[]
  // Estimated rendered lines, heading included.
  lines: number
}

const WRAP_COLS = 90

// A rough rendered height in lines; enough to tell a long section from a short one.
export function blockLines(b: Block): number {
  switch (b.t) {
    case 'heading':
    case 'hr':
      return 1
    case 'p':
      return Math.max(1, Math.ceil(inlineText(b.c).length / WRAP_COLS))
    case 'code':
      return b.v === '' ? 1 : b.v.replace(/\n$/, '').split('\n').length
    case 'quote':
      return b.c.reduce((n, x) => n + blockLines(x), 0)
    case 'list':
      return b.items.reduce((n, it) => n + Math.max(1, it.blocks.reduce((m, x) => m + blockLines(x), 0)), 0)
    case 'table':
      return 1 + b.rows.length
  }
}

// Splits blocks into sections at headings of rank `level` or higher (h1 also starts a section for level 2). Deeper
// headings stay inside their section. Blocks before the first heading form a section with a null heading; an empty
// one is left out.
export function sectionize(blocks: Block[], level: 2 | 3): MdSection[] {
  const out: MdSection[] = []
  let cur: MdSection = { heading: null, blocks: [], lines: 0 }
  const push = (): void => {
    if (cur.heading || cur.blocks.length) out.push(cur)
  }
  for (const b of blocks) {
    if (b.t === 'heading' && b.level <= level) {
      push()
      cur = { heading: b, blocks: [], lines: 1 }
    } else {
      cur.blocks.push(b)
      cur.lines += blockLines(b)
    }
  }
  push()
  return out
}
