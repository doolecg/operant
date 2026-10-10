import { describe, expect, it } from 'vitest'
import { buildEnhancePrompt, mergeSkills, parseEnhanceReply, parseSkillFile } from './prompt-enhance'

describe('prompt enhance', () => {
  it('builds the prompt with the instructions, skills and rough text', () => {
    const p = buildEnhancePrompt('fix the login', [{ name: 'debug', description: 'find bugs' }])
    expect(p).toContain('Load these skills:')
    expect(p).toContain('Ask me first about:')
    expect(p).toContain('Done when:')
    expect(p).toContain('- debug: find bugs')
    expect(p).toContain('"""\nfix the login\n"""')
    expect(buildEnhancePrompt('x', [])).toContain('Installed skills:\nnone')
  })
  it('strips a code fence from the reply and caps it', () => {
    expect(parseEnhanceReply('```\nDo it.\n\nDone when: ok\n```')).toBe('Do it.\n\nDone when: ok')
    expect(parseEnhanceReply('   ')).toBe('')
    expect(parseEnhanceReply('a'.repeat(7000))).toHaveLength(6000)
  })
  it('reads a skill front matter and merges lists without repeats', () => {
    expect(parseSkillFile('---\nname: "plan"\ndescription: Make plans\n---\nbody')).toEqual({ name: 'plan', description: 'Make plans' })
    expect(parseSkillFile('no front matter')).toEqual({})
    const m = mergeSkills([{ name: 'a', description: '1' }], [{ name: 'a', description: '2' }, { name: 'b', description: '' }])
    expect(m.map((s) => s.name)).toEqual(['a', 'b'])
    expect(m[0]!.description).toBe('1')
  })
})
