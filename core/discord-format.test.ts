import { describe, expect, it } from 'vitest'
import { scrubSecrets } from './discord'
import { chunkForDiscord, defangMentions, discordOutcome, markdownForDiscord } from './discord-format'

const fences = (s: string) => (s.match(/^```/gm) ?? []).length

describe('markdownForDiscord', () => {
  it('keeps what Discord renders and turns h4+ into bold lines', () => {
    const out = markdownForDiscord('# One\n## Two\n### Three\n#### Four\n**b** *i* ~~s~~ `c`\n> q')
    expect(out).toBe('# One\n## Two\n### Three\n**Four**\n**b** *i* ~~s~~ `c`\n> q')
  })

  it('turns a table into an aligned code block', () => {
    const out = markdownForDiscord('| Name | Count |\n|:--|--:|\n| alpha | 7 |\n| `b` | **12** |\nafter')
    expect(out).toBe('```\nName  | Count\n------+------\nalpha |     7\nb     |    12\n```\nafter')
  })

  it('handles a big table', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `| row ${i} | ${'x'.repeat(40)} |`).join('\n')
    const out = markdownForDiscord(`| a | b |\n|---|---|\n${rows}`)
    expect(out.split('\n')).toHaveLength(304)
    const chunks = chunkForDiscord(out)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000)
      expect(fences(c) % 2).toBe(0)
      expect(c.startsWith('```')).toBe(true)
    }
  })

  it('strips html, rewrites images and links, keeps code untouched', () => {
    const out = markdownForDiscord('<b>hi</b><script>x()</script> ![logo](https://a.com/l.png) [site](https://a.com) https://b.com/x. `<div> https://c.com`')
    expect(out).toBe('hix() logo <https://a.com/l.png> site <https://a.com> <https://b.com/x>. `<div> https://c.com`')
  })

  it('defangs mentions but not inside code blocks', () => {
    expect(defangMentions('@everyone @here <@123> <@!123> <@&9>')).toBe('@​everyone @​here <​@123> <​@!123> <​@&9>')
    const out = markdownForDiscord('ping @everyone and <@&55>\n```\n@everyone\n```')
    expect(out).toContain('@​everyone and <​@&55>')
    expect(out).toContain('```\n@everyone\n```')
  })

  it('writes task items, nested lists and rules', () => {
    expect(markdownForDiscord('- [x] a\n- [ ] b\n    - deep\n1. n\n---')).toBe('- ✅ a\n- ⬜ b\n  - deep\n1. n\n──────────')
  })

  it('scrubs secrets with the given scrubber and closes a dangling fence', () => {
    const token = 'A'.repeat(24) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(27)
    const out = markdownForDiscord(`token ${token}\n\`\`\`\nopen`, { scrub: (t) => scrubSecrets(t) })
    expect(out).toBe('token [token]\n```\nopen\n```')
  })
})

describe('chunkForDiscord', () => {
  it('returns short text whole', () => {
    expect(chunkForDiscord('hi')).toEqual(['hi'])
    expect(chunkForDiscord('x'.repeat(2000))).toHaveLength(1)
  })

  it('closes and reopens a fence that spans chunks', () => {
    const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i}`).join('\n')
    const chunks = chunkForDiscord(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000)
      expect(fences(c) % 2).toBe(0)
    }
    expect(chunks[1]!.startsWith('```ts\n')).toBe(true)
    expect(chunks[0]!.endsWith('\n```')).toBe(true)
    expect(chunks.at(-1)!.endsWith('outro')).toBe(true)
    const rebuilt = chunks.join('\n').replace(/\n```\n```ts\n/g, '\n')
    expect(rebuilt).toBe(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`)
  })

  it('breaks at lines and spaces, not inside words', () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkForDiscord(text, 300)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300)
    expect(chunks.join(' ')).toBe(text)
    expect(chunkForDiscord('y'.repeat(4500)).map((c) => c.length)).toEqual([2000, 2000, 500])
  })

  it('stays within the limit for one huge line inside a fence', () => {
    const chunks = chunkForDiscord(`\`\`\`\n${'z'.repeat(5000)}\n\`\`\``)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000)
      expect(fences(c) % 2).toBe(0)
    }
  })
})

describe('discordOutcome', () => {
  it('puts the header first and neutralises mentions in it', () => {
    const [first] = discordOutcome('JOB#20001 done', '# Result\n- ok')
    expect(first).toBe('JOB#20001 done\n# Result\n- ok')
    expect(discordOutcome('JOB#1 done', '')).toEqual(['JOB#1 done'])
  })
})
