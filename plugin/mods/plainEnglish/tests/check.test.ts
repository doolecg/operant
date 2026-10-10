import { expect, test } from 'claude-code/testing'

import { MAX_CHECKS, checkReply } from '../hooks/check'
import { EMPTY_VIEW } from '../hooks/view'
import type { PlainEnglishView } from '../types'

const REPLY = 'Done.\n\nSummary\nThe fix is in.\n\nNext steps\n- Run the tests.'
const USAGE = { input_tokens: 300, output_tokens: 8 }

// An in-memory view standing in for the plugin's state, with a model stub.
function harness(answer: (prompt: string) => Promise<unknown>) {
  let view: PlainEnglishView = EMPTY_VIEW
  const toasts: string[] = []
  const prompts: string[] = []
  const deps = {
    complete: async (prompt: string) => {
      prompts.push(prompt)

      return (await answer(prompt)) as never
    },
    toast: (text: string) => {
      toasts.push(text)
    },
    read: async () => view,
    write: async (change: (current: PlainEnglishView) => PlainEnglishView) => {
      view = change(view)
    },
  }

  return { deps, toasts, prompts, current: () => view }
}

test('a reply that misses a rule is recorded, toasted, and checked by the cheap model', async () => {
  const { deps, toasts, prompts, current } = harness(async () => ({
    isAnswered: true,
    text: 'FAIL: 3 prose outside Summary',
    usage: USAGE,
  }))

  await checkReply(deps, REPLY)

  expect(prompts.length).toBe(1)
  expect(toasts).toEqual(['Plain-English: missed: 3 prose outside Summary'])
  expect(current().verdict?.kind).toBe('missed')
  expect(current().checks).toBe(1)
  expect(current().tokens).toBe(308)
})

test('a failed model call is recorded as the check did not run, with no toast', async () => {
  const { deps, toasts, current } = harness(async () => {
    throw new Error('blocked')
  })

  await checkReply(deps, REPLY)

  expect(toasts).toEqual([])
  expect(current().verdict?.note).toBe('check did not run')
})

test('checks stop at the per-session cap', async () => {
  const { deps, prompts } = harness(async () => ({ isAnswered: true, text: 'PASS', usage: USAGE }))

  for (let index = 0; index < MAX_CHECKS + 3; index += 1) await checkReply(deps, REPLY)

  expect(prompts.length).toBe(MAX_CHECKS)
})
