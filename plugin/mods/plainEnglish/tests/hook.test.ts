import { expect, test } from 'claude-code/testing'

test('the rules go into the system prompt as a session section, beside the others', async ($, on) => {
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }],
  }))

  const composed = await $.prompt.compose({ model: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const ids = composed.sections.map(section => section.id)

  expect(ids).toEqual(['intro', 'plain-english:rules'])
  expect(composed.sections[1]?.scope).toBe('session')
})

test('a prompt sets the status line to what the session is working on', async ($, on) => {
  const statuses: (string | undefined)[] = []

  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))

  await $.prompt.submit({ text: 'Fix the   login bug', wait: false, origin: { kind: 'composer' } })

  expect(statuses[statuses.length - 1]).toBe('Working on: Fix the login bug')
})
