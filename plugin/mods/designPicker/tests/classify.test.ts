import { expect, test } from 'claude-code/testing'

import { designQuestions } from '../hooks/classify'

test('a question about design styles is picked up with its options', () => {
  const found = designQuestions([
    {
      question: 'Which style should the page use?',
      header: 'Style',
      multiSelect: false,
      options: [{ label: 'Minimal', description: 'Lots of space' }, { label: 'Brutalist' }],
    },
  ])

  expect(found.length).toBe(1)
  expect(found[0]?.header).toBe('Style')
  expect(found[0]?.options.map(option => option.label)).toEqual(['Minimal', 'Brutalist'])
})

test('a question whose options are known styles is picked up without design words', () => {
  const found = designQuestions([
    { question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'Dark' }, { label: 'Light' }] },
  ])

  expect(found.length).toBe(1)
})

test('an unrelated question is left alone', () => {
  const found = designQuestions([
    { question: 'Should I look into the failing test?', header: 'Check', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
  ])

  expect(found).toEqual([])
})

test('malformed input is ignored rather than thrown on', () => {
  expect(designQuestions(undefined)).toEqual([])
  expect(designQuestions([{ question: 5 }, null, { question: 'Style?', options: [{ label: 'Only one' }] }])).toEqual([])
})
