import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { CHECK_TIMEOUT_MS, MIN_CHECK_CHARS, checkReply } from './check'
import { SECTION } from './rules'
import { EMPTY_VIEW } from './view'

const view = atom({ plugin: 'plain-english', key: 'view' } as const, EMPTY_VIEW)

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'plain-english:rules', text: SECTION, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const topic = e.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    await update($, view, current => ({ ...current, topic }))
    $.ui.status(`Working on: ${topic}`)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const { topic } = await read($, view)
      $.ui.status(topic === '' ? `Running ${e.tool}` : `Working on: ${topic} (running ${e.tool})`)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      $.ui.status(undefined)
      if (e.reason === 'answer' && e.answer.trim().length >= MIN_CHECK_CHARS) await checkReply(
          {
            complete: prompt => $.model.complete({ model: 'haiku', prompt, maxTokens: 40, effort: 'low', timeoutMs: CHECK_TIMEOUT_MS }),
            toast: text => $.ui.toast(text),
            read: () => read($, view),
            write: async change => {
              await update($, view, change)
            },
          },
          e.answer,
        )
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { verdict } = await read($, view)
    if (verdict === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>Plain-English: {verdict.note}</Text>
      </Box>
    )
  })
}
