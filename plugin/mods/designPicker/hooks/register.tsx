import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DesignPending, DesignQuestion } from '../types'

import { designQuestions } from './classify'
import { renderGallery } from './gallery'

const pending = atom({ plugin: 'design-picker', key: 'pending' } as const, null as DesignPending | null)

const PREVIEW_NAME = 'claude-design-picker.html'

export const register: Register = on => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = designQuestions(e.questions)
    if (questions.length === 0) return next(e)

    const previewPath = await showPreview($, questions)
    await update($, pending, () => ({ questions, previewPath }))
    try {
      return await next(e)
    } finally {
      await update($, pending, () => null)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, pending)
    if (current === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const file = current.previewPath

    return (
      <Box flexDirection="column">
        {current.questions.map(question => (
          <Box key={question.question}>
            <Text>
              {question.header || 'Design'}: {question.options.map(option => option.label).join(' | ')}
            </Text>
          </Box>
        ))}
        <Text dimColor>Design Picker: the options are open as a preview in your browser. Pick one in Claude's question.</Text>
        {file !== undefined && (
          <Button key="reopen" label="Reopen preview" onPress={() => reopen($, file)} />
        )}
      </Box>
    )
  })
}

// Writes the gallery to the OS temp folder and opens it. Failures become a
// toast; the question itself is never touched.
async function showPreview($: EngineInterface, questions: readonly DesignQuestion[]): Promise<string | undefined> {
  try {
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR'))
    if (dir === undefined) throw new Error('no temp folder is set')

    const file = joinPath(dir, PREVIEW_NAME)
    await $.fs.write(file, renderGallery(questions))
    const failure = await openInBrowser($, file)
    if (failure !== undefined) $.ui.toast(`Design Picker: preview saved at ${file}, but it did not open (${failure}).`)

    return file
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    $.ui.toast(`Design Picker: no preview (${reason}). Pick from the options in the question.`)

    return undefined
  }
}

async function reopen($: EngineInterface, file: string): Promise<void> {
  const failure = await openInBrowser($, file)
  if (failure !== undefined) $.ui.toast(`Design Picker: the preview did not open (${failure}).`)
}

// The first opener that starts and exits 0 wins; the result names why none did.
async function openInBrowser($: EngineInterface, file: string): Promise<string | undefined> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const openers = isWindows ? [['cmd', '/c', 'start', '', file]] : [['open', file], ['xdg-open', file]]
  let reason = 'no opener found'

  for (const argv of openers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 5000 })
      if (ran.exitCode === 0) return undefined
      reason = `${argv[0]} exited ${ran.exitCode}`
    } catch {
      reason = `${argv[0]} could not run`
    }
  }

  return reason
}

function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/'

  return `${dir.replace(/[\\/]+$/, '')}${separator}${name}`
}
