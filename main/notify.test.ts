import { describe, expect, it, vi } from 'vitest'
import { createRunNotifier, shouldNotify } from './notify'

const run = { id: 20001, task: 'Fix the build', status: 'review' as const, question: '' }

function setup(over: { enabled?: boolean; focused?: boolean } = {}) {
  const show = vi.fn()
  const onClick = vi.fn()
  const notify = createRunNotifier({
    enabled: () => over.enabled ?? true,
    focused: () => over.focused ?? false,
    getRun: () => run,
    show,
    onClick,
  })
  return { notify, show, onClick }
}

describe('shouldNotify', () => {
  it('notifies for needs-you, review and failed only', () => {
    for (const s of ['needs-you', 'review', 'failed'] as const) expect(shouldNotify('working', s, true, false)).toBe(true)
    for (const s of ['queued', 'working', 'done'] as const) expect(shouldNotify('working', s, true, false)).toBe(false)
  })
  it('skips when off, focused or unchanged', () => {
    expect(shouldNotify('working', 'review', false, false)).toBe(false)
    expect(shouldNotify('working', 'review', true, true)).toBe(false)
    expect(shouldNotify('review', 'review', true, false)).toBe(false)
  })
})

describe('run notifier', () => {
  it('shows once per move and click opens the run', () => {
    const { notify, show, onClick } = setup()
    notify(20001, 'working')
    notify(20001, 'review')
    notify(20001, 'review')
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0]![0].title).toContain('ready for review')
    show.mock.calls[0]![1]()
    expect(onClick).toHaveBeenCalledWith(20001)
  })
  it('stays quiet with the setting off or the window focused', () => {
    const a = setup({ enabled: false })
    a.notify(20001, 'failed')
    const b = setup({ focused: true })
    b.notify(20001, 'failed')
    expect(a.show).not.toHaveBeenCalled()
    expect(b.show).not.toHaveBeenCalled()
  })
})
