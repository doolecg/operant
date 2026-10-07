import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const plugin = join(__dirname, '..', 'plugin')
const rolesDir = join(plugin, 'roles')
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

const ROLES = [
  'project-manager',
  'researcher',
  'designer',
  'implementor',
  'senior-implementor',
  'tester',
  'reviewer'
]
const lf = (s: string): string => s.replace(/\r\n/g, '\n')
const read = (name: string): string => lf(readFileSync(join(rolesDir, `${name}.md`), 'utf8'))
const skill = lf(readFileSync(join(plugin, 'skills', 'operant', 'SKILL.md'), 'utf8'))

describe('role files', () => {
  it('ships exactly the common file, the Master PM role and the seven roles', () => {
    expect(readdirSync(rolesDir).sort()).toEqual(['_common.md', 'master-pm.md', ...ROLES.map((r) => `${r}.md`)].sort())
  })

  it('keeps _common.md at or under 200 words', () => {
    expect(words(read('_common'))).toBeLessThanOrEqual(200)
  })

  it.each(ROLES)('%s stays within its word budget', (role) => {
    const n = words(read(role))
    expect(n).toBeGreaterThanOrEqual(90)
    expect(n).toBeLessThanOrEqual(260)
  })

  it.each(ROLES)('%s has a purpose line, rules, a Never line, handoff and done report', (role) => {
    const text = read(role)
    expect(text).toMatch(/^# Role: /)
    expect((text.match(/^- /gm) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(6)
    expect(text).toMatch(/^Never /m)
    expect(text).toMatch(/^Handoff:/m)
    expect(text).toMatch(/^Done report/m)
  })

  it('states the protocol points in _common.md', () => {
    const text = read('_common')
    for (const needle of [
      'operant whoami',
      'operant inbox',
      '--wait',
      'from the user (via the Operant dashboard)',
      'job list --open',
      'job claim',
      'job done',
      'job release',
      'job handoff',
      'codegraph explore',
      'operant ask user'
    ]) {
      expect(text).toContain(needle)
    }
    for (const code of ['4', '6', '7']) expect(text).toMatch(new RegExp(`(?:Exit codes: | )${code} `))
  })

  it('uses no forbidden vocabulary and no secrets', () => {
    const forbidden = /\b(rigs?|pods?|seats?|heartbeats?|compan(?:y|ies))\b/i
    const secret = /(OPERANT_TOKEN|sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|password\s*[:=]|Bearer\s+\S+)/i
    for (const [name, text] of [
      ...['_common', ...ROLES].map((n) => [n, read(n)] as const),
      ['SKILL', skill] as const
    ]) {
      expect(text, name).not.toMatch(forbidden)
      expect(text, name).not.toMatch(secret)
    }
  })
})

describe('operant skill', () => {
  it('has a short description and a short body that does not repeat the protocol', () => {
    const m = /^---\nname: operant\ndescription: (.+)\n---\n([\s\S]*)$/.exec(skill)
    if (!m) throw new Error('SKILL.md front matter not found')
    const description = m[1] ?? ''
    const body = m[2] ?? ''
    expect(description.length).toBeLessThanOrEqual(300)
    expect(words(body)).toBeLessThanOrEqual(150)
    expect(body).toContain('operant --help')
    expect(body).toContain('from the user (via the Operant dashboard)')
    expect(body).not.toContain('job claim')
  })
})
