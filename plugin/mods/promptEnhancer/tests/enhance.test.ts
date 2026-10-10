import { expect, test } from 'claude-code/testing'

import { LIMITS, MARK, buildPrompt, cleanReply, parseSkill, withinBudget } from '../hooks/enhance'

test('only a prompt starting with "++ " is marked', () => {
  expect(MARK.test('++ fix the login bug')).toBe(true)
  expect(MARK.test('fix the login bug ++ ')).toBe(false)
  expect(MARK.test('++fix')).toBe(false)
})

test('a SKILL.md frontmatter gives its name and description', () => {
  const md = '---\nname: docx\ndescription: "Create and edit Word files."\n---\n# Body'
  expect(parseSkill(md)).toEqual({ name: 'docx', description: 'Create and edit Word files.' })
  expect(parseSkill('no frontmatter here')).toEqual({})
})

test('the request lists the skills and the rough prompt', () => {
  const prompt = buildPrompt('make it faster', [{ name: 'xlsx', description: 'Spreadsheets' }])
  expect(prompt.includes('- xlsx: Spreadsheets')).toBe(true)
  expect(prompt.includes('make it faster')).toBe(true)
  expect(buildPrompt('x', [], 'could not read').includes('(could not read)')).toBe(true)
})

test('a fenced reply is unwrapped and an empty one is empty', () => {
  expect(cleanReply('```text\nDo the thing.\nDone when: tests pass\n```')).toBe('Do the thing.\nDone when: tests pass')
  expect(cleanReply('   ')).toBe('')
})

test('the session budget stops rewrites', () => {
  expect(withinBudget({ calls: 0, tokens: 0 })).toBe(true)
  expect(withinBudget({ calls: LIMITS.calls, tokens: 0 })).toBe(false)
  expect(withinBudget({ calls: 1, tokens: LIMITS.tokens })).toBe(false)
})
