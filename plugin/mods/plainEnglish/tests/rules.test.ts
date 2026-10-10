import { expect, test } from 'claude-code/testing'

import { RULES, SECTION, buildCheck, parseVerdict } from '../hooks/rules'

test('a PASS line is ok and a FAIL line names the missed rule', () => {
  expect(parseVerdict('PASS')).toEqual({ kind: 'ok', note: 'ok' })
  expect(parseVerdict('FAIL: 4 Next steps section')).toEqual({ kind: 'missed', note: 'missed: 4 Next steps section' })
  expect(parseVerdict('FAIL:')).toEqual({ kind: 'missed', note: 'missed: a rule' })
})

test('an answer that is neither PASS nor FAIL is unclear, not a miss', () => {
  expect(parseVerdict('Sure, here it is.')).toEqual({ kind: 'unclear', note: 'check unclear' })
})

test('the check prompt carries every rule and only the first part of a long reply', () => {
  const prompt = buildCheck('x'.repeat(9000))

  for (const rule of RULES) expect(prompt).toContain(rule)
  expect(prompt.length).toBeLessThan(4500)
})

test('the system prompt section stays short', () => {
  expect(SECTION.split(/\s+/).length).toBeLessThan(70)
})
