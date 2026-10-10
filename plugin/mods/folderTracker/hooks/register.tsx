import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Tracker } from '../types'
import { PRUNE_MS, SAVE_EVERY_MS, addFile, describeOther, isLive, isTracker, relativeTo, sameFile, trackerKey, trackerPrefix } from './tracker'

let last: { phase: Phase; savedAt: number } | undefined
const warned = new Set<string>()

async function record($: EngineInterface, patch: { phase: Phase; file?: string }, id?: string): Promise<void> {
  const now = await $.clock.now()
  if (patch.file === undefined && last && last.phase === patch.phase && now - last.savedAt < SAVE_EVERY_MS) return
  last = { phase: patch.phase, savedAt: now }
  const cwd = await $.session.cwd()
  const key = trackerKey(cwd, id ?? (await $.session.id()))
  const before: unknown = await $.store.get(key)
  const base: Tracker = isTracker(before) ? before : { id: key.slice(trackerPrefix(cwd).length), cwd, phase: patch.phase, at: now, files: [] }
  const files = patch.file === undefined ? base.files : addFile(base.files, patch.file, now)
  await $.store.set(key, { ...base, cwd, phase: patch.phase, at: now, files })
  $.ui.invalidate('ui.render')
}

async function otherSessions($: EngineInterface): Promise<Tracker[]> {
  const cwd = await $.session.cwd()
  const me = trackerKey(cwd, await $.session.id())
  const now = await $.clock.now()
  const keys = (await $.store.keys()).filter(key => key.startsWith(trackerPrefix(cwd)) && key !== me)
  const values = await Promise.all(keys.map(key => $.store.get(key)))
  return values.filter(isTracker).filter(tracker => isLive(tracker, now)).sort((a, b) => b.at - a.at)
}

async function prune($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  for (const key of (await $.store.keys()).filter(k => k.startsWith(trackerPrefix(cwd)))) {
    const value: unknown = await $.store.get(key)
    if (isTracker(value) && now - value.at > PRUNE_MS) await $.store.delete(key)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await prune($)
      await record($, { phase: 'idle' })
    } catch {
      $.ui.toast('Same-Folder Session Tracker could not start')
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await record($, { phase: 'working' })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await record($, { phase: 'working' })
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined && verdict.decision === 'ask') await record($, { phase: 'waiting' })
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined
    if (file === undefined) {
      await record($, { phase: 'working' })
      return next(e)
    }
    const cwd = await $.session.cwd()
    const clash = (await otherSessions($)).find(other => other.files.some(f => sameFile(f.path, file)))
    if (clash !== undefined && !warned.has(file)) {
      warned.add(file)
      $.ui.toast(`Another session in this folder also edited ${relativeTo(cwd, file)}. Check it before going on.`)
    }
    const ran = await next(e)
    if (ran.deny === undefined) await record($, { phase: 'working', file })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await record($, { phase: 'idle' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await record($, { phase: 'done' }, e.sessionId)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await otherSessions($)
    if (others.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    return (
      <Box flexDirection="column">
        {others.slice(0, 3).map(other => (
          <Box key={other.id}>
            <Text dimColor>{describeOther(other, cwd)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
