import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Proposal, Usage } from '../types'
import { LIMITS, MARK, SYSTEM_PROMPT, buildPrompt, cleanReply, parseSkill, withinBudget } from './enhance'
import type { Skill } from './enhance'

const pending = atom({ plugin: 'prompt-enhancer', key: 'pending' } as const, null as Proposal | null)
const usage = atom({ plugin: 'prompt-enhancer', key: 'usage' } as const, { calls: 0, tokens: 0 } as Usage)

async function listSkills($: EngineInterface): Promise<{ skills: Skill[]; note?: string }> {
  const found = new Map<string, Skill>()
  const notes: string[] = []
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const dir = `${home}/.claude/skills`
    for (const entry of (await $.fs.list(dir)).slice(0, 200)) {
      if (entry.kind !== 'dir') continue
      try {
        const parsed = parseSkill(await $.fs.read(`${dir}/${entry.name}/SKILL.md`))
        const name = parsed.name ?? entry.name
        found.set(name, { name, description: parsed.description ?? '' })
      } catch {
        found.set(entry.name, { name: entry.name, description: '' })
      }
    }
  } catch {
    notes.push('could not read ~/.claude/skills')
  }
  try {
    for (const command of await $.command.list()) {
      if (command.source === 'plugin') found.set(command.name, { name: command.name, description: command.description })
    }
  } catch {
    notes.push('could not list plugin skills')
  }
  return { skills: [...found.values()].slice(0, LIMITS.skills), note: notes.length ? notes.join('; ') : undefined }
}

async function rewrite($: EngineInterface, rough: string): Promise<{ text: string } | { error: string }> {
  try {
    const spent = await read($, usage)
    if (!withinBudget(spent)) return { error: 'the session limit of rewrites is used up' }
    const { skills, note } = await listSkills($)
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(rough, skills, note),
      maxTokens: LIMITS.maxTokens,
      effort: 'low',
      timeoutMs: LIMITS.timeoutMs,
    })
    await update($, usage, u => ({
      calls: u.calls + 1,
      tokens: u.tokens + reply.usage.input_tokens + reply.usage.output_tokens,
    }))
    if (!reply.isAnswered) return { error: `the model did not answer (${reply.reason})` }
    const text = cleanReply(reply.text)
    return text === '' ? { error: 'the model returned nothing usable' } : { text }
  } catch (err) {
    return { error: `the rewrite failed (${err instanceof Error ? err.message : 'unknown error'})` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'enhance',
        description: 'Rewrite a rough prompt for review in the band above the prompt',
        argumentHint: '<rough prompt>',
      })
    } catch {
      $.ui.toast('Prompt Enhancer: could not register /enhance')
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!MARK.test(e.text)) return next(e)
    const rough = e.text.replace(MARK, '')
    $.ui.status('Prompt Enhancer: rewriting...')
    const result = await rewrite($, rough)
    $.ui.status(undefined)
    if ('error' in result) {
      const { isFilled } = await $.prompt.fill({ text: rough, mode: 'replace' })
      $.ui.toast(`Prompt Enhancer: ${result.error}${isFilled ? '; your text is back in the box' : '; your text was not sent'}`)
      return { drop: 'Prompt Enhancer could not rewrite this prompt.' }
    }
    await update($, pending, () => ({ original: rough, proposal: result.text }))
    $.ui.invalidate('ui.render')
    return { drop: 'Prompt Enhancer: the rewrite is ready in the band above the prompt. Use, Edit or Cancel.' }
  }).catch(($, e, next) => (next.called || !MARK.test(e.text) ? next(e) : { drop: 'Prompt Enhancer failed; the prompt was not sent.' }))

  on('command.run', { command: 'enhance' }, async ($, e) => {
    const rough = e.args.trim()
    if (rough === '') {
      $.ui.toast('Usage: /enhance <rough prompt>')
      return {}
    }
    $.ui.status('Prompt Enhancer: rewriting...')
    const result = await rewrite($, rough)
    $.ui.status(undefined)
    if ('error' in result) {
      $.ui.toast(`Prompt Enhancer: ${result.error}`)
      return {}
    }
    await update($, pending, () => ({ original: rough, proposal: result.text }))
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, pending)
    if (current === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    const settle = async (mode: 'use' | 'edit' | 'cancel') => {
      const p = await read($, pending)
      if (p === null) return
      await update($, pending, () => null)
      $.ui.invalidate('ui.render')
      if (mode === 'use') await $.prompt.submit({ text: p.proposal, asUser: true })
      else if (mode === 'edit') await $.prompt.fill({ text: p.proposal, mode: 'replace' })
      else await $.prompt.fill({ text: p.original, mode: 'replace' })
    }

    return (
      <Box flexDirection="column">
        <Text bold>Prompt Enhancer: review the rewrite</Text>
        <Text>{current.proposal}</Text>
        <Box>
          <Button key="use" label="Use" variant="primary" onPress={() => settle('use')} />
          <Button key="edit" label="Edit" onPress={() => settle('edit')} />
          <Button key="cancel" label="Cancel" role="dismiss" onPress={() => settle('cancel')} />
        </Box>
      </Box>
    )
  })
}
