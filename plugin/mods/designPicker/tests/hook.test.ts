import { expect, mock, test } from 'claude-code/testing'

const STYLE_QUESTION = {
  question: 'Which design style should the page use?',
  header: 'Style',
  multiSelect: false,
  options: [{ label: 'Minimal', description: 'Lots of space' }, { label: 'Brutalist', description: 'Bold borders' }],
}

const BACKSLASH = String.fromCharCode(92)
const TEMP = `C:${BACKSLASH}Temp`
const PREVIEW = `${TEMP}${BACKSLASH}claude-design-picker.html`
const RAN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('a design question writes the preview, opens it, and reaches the dialog unchanged', async ($, on) => {
  mock.env(on, { TEMP, OS: 'Windows_NT' })
  const writes: { path: string; text: string }[] = []
  const runs: (readonly string[])[] = []
  const toasts: string[] = []
  let asked = 0

  on('fs.write', ($, e) => {
    writes.push(e)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)

    return { value: RAN_OK }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked += 1

    return { result: { answers: { Style: 'Minimal' } } }
  })

  await $.tool.call({ tool: 'AskUserQuestion', questions: [STYLE_QUESTION] })

  expect(asked).toBe(1)
  expect(writes.length).toBe(1)
  expect(writes[0]?.path).toBe(PREVIEW)
  expect(writes[0]?.text).toContain('look-minimal')
  expect(runs[0]).toEqual(['cmd', '/c', 'start', '', PREVIEW])
  expect(writes[0]?.path.includes(BACKSLASH + BACKSLASH)).toBe(false)
  expect(toasts).toEqual([])
})

test('a question that is not about design is not previewed', async ($, on) => {
  mock.env(on, { TEMP, OS: 'Windows_NT' })
  let writes = 0

  on('fs.write', () => {
    writes += 1

    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: {} } }))

  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Run the tests now?', header: 'Tests', multiSelect: false, options: [{ label: 'Yes', description: 'Run them' }, { label: 'No', description: 'Skip' }] }],
  })

  expect(writes).toBe(0)
})

test('a failed opener shows a toast and the question still goes ahead', async ($, on) => {
  mock.env(on, { TEMP, OS: 'Windows_NT' })
  const toasts: string[] = []
  let asked = 0

  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => {
    throw new Error('spawn refused')
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked += 1

    return { result: { answers: { Style: 'Brutalist' } } }
  })

  await $.tool.call({ tool: 'AskUserQuestion', questions: [STYLE_QUESTION] })

  expect(asked).toBe(1)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('did not open')
})
