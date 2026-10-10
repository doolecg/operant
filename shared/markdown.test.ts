import { describe, expect, it } from 'vitest'
import { isNextSteps, markdownToPlain, sectionName, parseMarkdown, safeHref, sectionize, type Block, type Inline } from './markdown'

const links = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => links(x, out))
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.t === 'link') out.push(o.href as string)
    Object.values(o).forEach((x) => links(x, out))
  }
  return out
}
const text = (nodes: Inline[]): string => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : n.t === 'link' || n.t === 'strong' || n.t === 'em' || n.t === 'del' ? text(n.c) : '')).join('')

describe('blocks', () => {
  it('parses headings, paragraphs, rules and breaks', () => {
    const b = parseMarkdown('# Title\n\nline one\nline two\n\n---\n\n### Third')
    expect(b.map((x) => x.t)).toEqual(['heading', 'p', 'hr', 'heading'])
    expect((b[0] as Extract<Block, { t: 'heading' }>).level).toBe(1)
    expect(text((b[1] as Extract<Block, { t: 'p' }>).c)).toBe('line one\nline two')
  })

  it('parses fenced code verbatim, including an unclosed fence', () => {
    const b = parseMarkdown('```ts\nconst a = **1**\n```\n\n```\nopen')
    expect(b[0]).toEqual({ t: 'code', lang: 'ts', v: 'const a = **1**' })
    expect(b[1]).toEqual({ t: 'code', lang: '', v: 'open' })
  })

  it('parses nested ordered and unordered lists and task items', () => {
    const b = parseMarkdown('- a\n  - b\n  - c\n- [x] done\n- [ ] todo\n\n1. one\n2. two')
    const list = b[0] as Extract<Block, { t: 'list' }>
    expect(list.items).toHaveLength(3)
    expect(list.items[0]!.blocks.map((x) => x.t)).toEqual(['p', 'list'])
    expect(list.items[1]!.task).toBe(true)
    expect(list.items[2]!.task).toBe(false)
    expect((b[1] as Extract<Block, { t: 'list' }>).ordered).toBe(true)
  })

  it('parses blockquotes and tables', () => {
    const b = parseMarkdown('> quoted **bold**\n\n| A | B |\n|:--|--:|\n| 1 | `x\\|y` |\n| 2 |')
    expect(b[0]!.t).toBe('quote')
    const t = b[1] as Extract<Block, { t: 'table' }>
    expect(t.align).toEqual(['left', 'right'])
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]![1]).toEqual([{ t: 'code', v: 'x|y' }])
    expect(t.rows[1]![1]).toEqual([])
  })
})

describe('inline', () => {
  const inline = (s: string) => (parseMarkdown(s)[0] as Extract<Block, { t: 'p' }>).c
  it('parses emphasis, strike and code', () => {
    expect(inline('**b** *i* ~~s~~ `c`').map((n) => n.t)).toEqual(['strong', 'text', 'em', 'text', 'del', 'text', 'code'])
  })
  it('leaves unbalanced markup as text', () => {
    expect(text(inline('**open *a ~~b `c [d](e'))).toBe('**open *a ~~b `c [d](e')
    expect(text(inline('2 * 3 * 4 snake_case_name'))).toBe('2 * 3 * 4 snake_case_name')
  })
  it('handles deeply nested markup without throwing', () => {
    expect(() => parseMarkdown('*'.repeat(500) + 'x' + '*'.repeat(500))).not.toThrow()
    expect(() => parseMarkdown('> '.repeat(200) + 'x')).not.toThrow()
    expect(() => parseMarkdown('- '.repeat(200) + 'x')).not.toThrow()
    expect(() => parseMarkdown('[a]('.repeat(300))).not.toThrow()
  })
  it('autolinks bare urls without the trailing punctuation', () => {
    const c = inline('see https://example.com/a_(b). and <https://x.dev>')
    expect(links(c)).toEqual(['https://example.com/a_(b)', 'https://x.dev'])
  })
})

describe('safety', () => {
  it('only allows http, https and mailto links', () => {
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///c:/x', '/relative', '//evil.com', 'https://a.com/"onmouseover="x']) {
      expect(safeHref(bad), bad).toBeNull()
    }
    expect(safeHref('https://a.com/x?y=1')).toBe('https://a.com/x?y=1')
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
  })
  it('never produces a link for a javascript: markdown link', () => {
    const b = parseMarkdown('[click](javascript:alert(1)) ![x](javascript:alert(2)) [ok](https://a.com) <javascript:alert(3)>')
    expect(links(b)).toEqual(['https://a.com'])
  })
  it('keeps raw html as plain text', () => {
    const b = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a](https://a.com "t\\" onerror=x")')
    expect(b[0]).toEqual({ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] })
    expect(text((b[1] as Extract<Block, { t: 'p' }>).c)).toBe('<img src=x onerror=alert(1)>')
    expect(JSON.stringify(b)).not.toContain('"t":"html"')
  })
  it('shows an image as its alt text, never as an image node', () => {
    const c = (parseMarkdown('![logo](https://a.com/x.png)')[0] as Extract<Block, { t: 'p' }>).c
    expect(c).toEqual([{ t: 'link', href: 'https://a.com/x.png', c: [{ t: 'text', v: 'logo' }] }])
  })
  it('stays fast on huge and pathological input', () => {
    const cases = ['*a '.repeat(150_000), '[a'.repeat(200_000), '`'.repeat(300_000), '**_~~'.repeat(80_000), '| a |\n|-|\n'.repeat(30_000), 'word '.repeat(300_000), '- x\n'.repeat(100_000)]
    for (const c of cases) {
      const t = Date.now()
      parseMarkdown(c)
      expect(Date.now() - t).toBeLessThan(3000)
    }
  })
})

describe('markdownToPlain', () => {
  it('strips markup to one short line', () => {
    expect(markdownToPlain('# Done\n\n- **fast** [link](https://a.com)\n- `code`\n\n```\nblock\n```')).toBe('Done fast link code block')
    expect(markdownToPlain('x'.repeat(500), 50)).toHaveLength(50)
  })
})

describe('sectionize', () => {
  const doc = (s: string) => sectionize(parseMarkdown(s), 2)

  it('splits at h2 and keeps the leading blocks apart', () => {
    const s = doc('intro\n\n## One\n\nbody 1\n\n## Two\n\nbody 2')
    expect(s.map((x) => (x.heading ? (x.heading as { level: number }).level : null))).toEqual([null, 2, 2])
    expect(s[0]!.blocks).toHaveLength(1)
    expect(s[1]!.blocks).toHaveLength(1)
  })

  it('no leading section when the document starts with a heading', () => {
    expect(doc('## A\n\nx').map((x) => x.heading !== null)).toEqual([true])
  })

  it('empty input has no sections', () => {
    expect(doc('')).toEqual([])
  })

  it('h3 stays inside an h2 section at level 2, and splits at level 3', () => {
    const md = '## A\n\n### a1\n\nx\n\n### a2\n\ny'
    expect(doc(md)).toHaveLength(1)
    expect(sectionize(parseMarkdown(md), 3)).toHaveLength(3)
  })

  it('h1 also starts a section', () => {
    expect(doc('# Title\n\n## A\n\nx')).toHaveLength(2)
  })

  it('a heading with no body counts as one line', () => {
    expect(doc('## A\n\n## B\n\nx').map((x) => x.lines)).toEqual([1, 2])
  })

  it('counts lines: paragraphs wrap, code lines, list items, table rows', () => {
    const code = '```\na\nb\nc\n```'
    const list = '- one\n- two\n- three'
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'
    const long = 'word '.repeat(60).trim()
    const s = doc(`## S\n\nshort\n\n${code}\n\n${list}\n\n${table}\n\n${long}`)
    expect(s[0]!.lines).toBe(1 + 1 + 3 + 3 + 3 + Math.ceil(long.length / 90))
  })

  it('a long section is detectable (over 40 lines)', () => {
    const body = Array.from({ length: 50 }, (_, i) => `- item ${i}`).join('\n')
    const s = doc(`## Short\n\nx\n\n## Long\n\n${body}`)
    expect(s[0]!.lines).toBeLessThanOrEqual(40)
    expect(s[1]!.lines).toBeGreaterThan(40)
  })

  it('keeps every block in order', () => {
    const blocks = parseMarkdown('a\n\n## B\n\nc\n\n---\n\nd')
    const s = sectionize(blocks, 2)
    expect(s.flatMap((x) => [...(x.heading ? [x.heading] : []), ...x.blocks])).toEqual(blocks)
  })
})

describe('reply sections', () => {
  const first = (src: string) => parseMarkdown(src)[0]!
  it('names headings and bold lead-ins', () => {
    expect(sectionName(first('## Summary'))).toBe('summary')
    expect(sectionName(first('**Next steps:**'))).toBe('next steps')
    expect(sectionName(first('**Not verified**'))).toBe('not verified')
  })
  it('leaves other text alone', () => {
    expect(sectionName(first('**Summary** and more words'))).toBeNull()
    expect(sectionName(first('## Something else'))).toBeNull()
    expect(sectionName(first('Summary'))).toBeNull()
  })
  it('knows the next-steps sections', () => {
    expect(isNextSteps('next steps')).toBe(true)
    expect(isNextSteps('summary')).toBe(false)
    expect(isNextSteps(null)).toBe(false)
  })
  it('parses the common chat features', () => {
    const b = parseMarkdown(['# T', '', '- [x] a', '  - nested', '', '1. one', '', '> q', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '---', '', '```ts', 'x', '```'].join('\n'))
    expect(b.map((x) => x.t)).toEqual(['heading', 'list', 'list', 'quote', 'table', 'hr', 'code'])
  })
})
