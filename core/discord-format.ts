import { inlineText, parseMarkdown } from '../shared/markdown'

// Turns a run outcome written in Markdown into Discord messages. Discord renders bold, italic, strikethrough, inline
// code, code blocks, quotes, lists and # to ### headings; it does not render tables, images or HTML, and a ping in
// the text must never fire.

export const DISCORD_MESSAGE_LIMIT = 2000
const ZWSP = '​'

export interface FormatOptions {
  // Removes secrets from the text (the gateway's own scrubber).
  scrub?: (text: string) => string
  // 'angle' (default) writes links as `text <url>` so Discord shows no preview card; 'plain' leaves bare urls alone.
  links?: 'angle' | 'plain'
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

// Breaks @everyone, @here and <@id>, <@!id>, <@&id> with a zero-width character so they do not ping.
export function defangMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, `@${ZWSP}$1`).replace(/<@([!&]?)(\d)/g, `<${ZWSP}@$1$2`)
}

const cell = (nodes: Parameters<typeof inlineText>[0]): string => inlineText(nodes).replace(/\s+/g, ' ').trim()
const width = (s: string): number => [...s].length

function pad(s: string, w: number, align: 'left' | 'center' | 'right' | null): string {
  const gap = w - width(s)
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2))
  return s + ' '.repeat(gap)
}

// A Markdown table as an aligned monospace block.
function tableToCode(lines: string[]): string[] | null {
  const t = parseMarkdown(lines.join('\n'))[0]
  if (t?.t !== 'table') return null
  const rows = [t.head.map(cell), ...t.rows.map((r) => r.map(cell))]
  const widths = t.head.map((_, k) => Math.min(60, Math.max(3, ...rows.map((r) => width(r[k] ?? '')))))
  const fit = (s: string, k: number): string => (width(s) > widths[k]! ? `${[...s].slice(0, widths[k]! - 1).join('')}…` : s)
  const line = (r: string[]) =>
    r
      .map((c, k) => pad(fit(c, k), widths[k]!, t.align[k] ?? null))
      .join(' | ')
      .trimEnd()
  const [head, ...body] = rows
  return ['```', line(head!), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line), '```']
}

// Applies `fn` to the text outside inline code spans only.
function outsideCode(line: string, fn: (s: string) => string): string {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('')
}

function inlineLine(line: string, links: 'angle' | 'plain'): string {
  return defangMentions(
    outsideCode(line, (s) => {
      let out = s.replace(/<!--.*?-->/g, '').replace(/<\/?[a-zA-Z][^<>]*>/g, '')
      out = out.replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?[^)]*\)/g, (_m, alt: string, url: string) =>
        links === 'angle' ? `${alt || 'image'} <${url}>` : `${alt || 'image'} ${url}`,
      )
      if (links === 'angle') {
        out = out.replace(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?[^)]*\)/g, (_m, text: string, url: string) => (text === url ? `<${url}>` : `${text} <${url}>`))
        out = out.replace(/(^|[^<\w(])(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g, '$1<$2>')
      }
      return out
    }),
  )
}

// Markdown to Discord-flavoured text (one string; chunkForDiscord splits it).
export function markdownForDiscord(markdown: string, opts: FormatOptions = {}): string {
  const links = opts.links ?? 'angle'
  const src = (opts.scrub ? opts.scrub(markdown) : markdown).replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  const lines = src.split('\n')
  const out: string[] = []
  let fence: string | null = null
  const stack: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      const t = line.trim()
      if (t.length >= fence.length && t.split(fence[0]!).join('') === '') {
        out.push('```')
        fence = null
      } else out.push(line.replace(/```/g, '`​``'))
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      fence = open[1]!
      out.push(`\`\`\`${open[2] ?? ''}`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      let end = i + 2
      while (end < lines.length && lines[end]!.trim() !== '' && lines[end]!.includes('|')) end++
      const code = tableToCode(lines.slice(i, end))
      if (code) {
        out.push(...code)
        i = end - 1
        stack.length = 0
        continue
      }
    }
    if (HR.test(line)) {
      out.push('──────────')
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      const text = inlineLine(h[2]!, links)
      out.push(h[1]!.length <= 3 ? `${h[1]} ${text}` : `**${text.replace(/\*\*/g, '')}**`)
      stack.length = 0
      continue
    }
    const li = LIST_ITEM.exec(line)
    if (li) {
      const indent = li[1]!.length
      while (stack.length && stack[stack.length - 1]! > indent) stack.pop()
      if (!stack.length || stack[stack.length - 1]! < indent) stack.push(indent)
      const level = Math.min(stack.length - 1, 3)
      const marker = /\d/.test(li[2]!) ? li[2]! : '-'
      const task = /^\[([ xX])\]\s+/.exec(li[3]!)
      const body = task ? `${task[1] === ' ' ? '⬜' : '✅'} ${li[3]!.slice(task[0].length)}` : li[3]!
      out.push(`${'  '.repeat(level)}${marker} ${inlineLine(body, links)}`)
      continue
    }
    if (line.trim() === '') stack.length = 0
    out.push(inlineLine(line, links))
  }
  if (fence) out.push('```')
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Splits text into messages of at most `max` characters. A code fence that spans messages is closed at the end of one
// and reopened at the start of the next; breaks fall on a line, then a space, and only inside a word as a last resort.
export function chunkForDiscord(text: string, max = DISCORD_MESSAGE_LIMIT): string[] {
  const out: string[] = []
  let cur = ''
  // The opening line of the code block being written, or null outside one.
  let opener: string | null = null
  // Whether the message holds anything besides a reopened fence line.
  let used = false

  const flush = () => {
    if (!used) return
    out.push(opener ? `${cur}\n\`\`\`` : cur)
    cur = opener ?? ''
    used = false
  }
  // Room for a line, keeping 4 characters free to close an open fence.
  const room = (closing: boolean) => max - (opener && !closing ? 4 : 0)
  const add = (piece: string, closing = false) => {
    let rest = piece
    for (;;) {
      const sep = cur ? '\n' : ''
      if (cur.length + sep.length + rest.length <= room(closing)) {
        cur += sep + rest
        used = true
        return
      }
      if (used) {
        flush()
        continue
      }
      // A line longer than a whole message: cut it at a space if there is one in the back half.
      const space = room(closing) - (cur ? cur.length + 1 : 0)
      let cut = rest.lastIndexOf(' ', space)
      if (cut < space / 2) cut = space
      cur += (cur ? '\n' : '') + rest.slice(0, cut)
      used = true
      flush()
      rest = rest.slice(cut).replace(/^ /, '')
      if (rest === '') return
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (opener) {
      const closing = trimmed === '```'
      add(line, closing)
      if (closing) opener = null
    } else if (trimmed.startsWith('```')) {
      // Check the room for the opener as if the fence were already open, so it can always be closed.
      if (used && cur.length + 1 + line.length > max - 4) flush()
      opener = trimmed
      add(line)
    } else add(line)
  }
  if (used || out.length === 0) out.push(cur)
  return out
}

// The messages for a job update: a header line, then the outcome as Discord text.
export function discordOutcome(header: string, outcome: string, opts: FormatOptions = {}): string[] {
  const head = defangMentions(opts.scrub ? opts.scrub(header) : header)
  const body = outcome.trim() ? markdownForDiscord(outcome, opts) : ''
  return chunkForDiscord(body ? `${head}\n${body}` : head)
}
