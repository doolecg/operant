import { describe, expect, it } from 'vitest'
import { appCloseLines, firstLine, notifyCopy, shouldConfirmAppClose, shouldConfirmTileClose, shouldNotify, tileCloseCopy } from './notify'

const on = { finished: true, needs: true }

describe('shouldConfirmTileClose', () => {
  it('asks for a live tile while the ask is on', () => expect(shouldConfirmTileClose(true, false)).toBe(true))
  it('does not ask when the owner turned it off', () => expect(shouldConfirmTileClose(false, false)).toBe(false))
  it('does not ask for a tile whose process already ended', () => expect(shouldConfirmTileClose(true, true)).toBe(false))
})

describe('shouldConfirmAppClose', () => {
  const none = { claude: 0, opencode: 0, shell: 0, midTurn: false }
  it('stays silent when nothing is running', () => expect(shouldConfirmAppClose(true, none)).toBe(false))
  it('asks when a shell or a Claude tile runs', () => {
    expect(shouldConfirmAppClose(true, { ...none, shell: 1 })).toBe(true)
    expect(shouldConfirmAppClose(true, { ...none, claude: 2 })).toBe(true)
  })
  it('respects "don\'t ask again"', () => expect(shouldConfirmAppClose(false, { ...none, claude: 1 })).toBe(false))
})

describe('tileCloseCopy', () => {
  it('says a running turn will be stopped', () => {
    expect(tileCloseCopy({ title: 'Claude: Operant', kind: 'claude', busy: true })).toEqual({
      title: 'Close this terminal?',
      body: 'Claude: Operant. Claude is still working and will be stopped.',
    })
  })
  it('says an idle session can be resumed', () => expect(tileCloseCopy({ title: 'Claude', kind: 'claude', busy: false }).body).toContain('can be resumed'))
  it('says a shell process will end', () => expect(tileCloseCopy({ title: 'Shell', kind: 'shell', busy: false }).body).toContain('The shell process will end.'))
})

describe('appCloseLines', () => {
  it('lists each running kind and the mid-turn warning', () => {
    const lines = appCloseLines({ claude: 2, opencode: 1, shell: 1, midTurn: true })
    expect(lines[0]).toBe('2 Claude tiles are running')
    expect(lines).toContain('1 OpenCode tile is running')
    expect(lines).toContain('1 shell is running')
    expect(lines).toContain('Claude is mid-turn: that turn will be stopped.')
  })
  it('uses singular counts', () => expect(appCloseLines({ claude: 1, opencode: 0, shell: 0, midTurn: false })[0]).toBe('1 Claude tile is running'))
})

describe('shouldNotify', () => {
  it('stays quiet while the owner is looking at the tile', () => {
    expect(shouldNotify({ kind: 'finished', enabled: on, windowFocused: true, tileVisible: true })).toBe(false)
  })
  it('notifies when the window is not focused', () => expect(shouldNotify({ kind: 'finished', enabled: on, windowFocused: false, tileVisible: true })).toBe(true))
  it('notifies when the tile is not visible', () => expect(shouldNotify({ kind: 'needs', enabled: on, windowFocused: true, tileVisible: false })).toBe(true))
  it('respects each toggle', () => {
    expect(shouldNotify({ kind: 'finished', enabled: { finished: false, needs: true }, windowFocused: false, tileVisible: false })).toBe(false)
    expect(shouldNotify({ kind: 'needs', enabled: { finished: true, needs: false }, windowFocused: false, tileVisible: false })).toBe(false)
  })
})

describe('firstLine', () => {
  it('takes the first non-empty line, trimmed', () => expect(firstLine('\n  Fixed the bug.  \nMore text')).toBe('Fixed the bug.'))
  it('collapses whitespace', () => expect(firstLine('a   b\t c')).toBe('a b c'))
  it('caps at 100 characters with an ellipsis', () => {
    const out = firstLine('x'.repeat(300))
    expect(out.length).toBe(100)
    expect(out.endsWith('…')).toBe(true)
  })
  it('is empty for no text', () => expect(firstLine(null)).toBe(''))
})

describe('notifyCopy', () => {
  it('titles a finished turn', () => {
    expect(notifyCopy({ kind: 'finished', name: 'Claude: Operant', detail: 'Added the dialog.' })).toEqual({
      title: 'Claude is done',
      body: 'Claude: Operant · Added the dialog.',
    })
  })
  it('titles a waiting Claude with the permission text', () => {
    expect(notifyCopy({ kind: 'needs', name: 'Claude: Operant', detail: 'Claude needs your permission to use Bash' })).toEqual({
      title: 'Claude needs you',
      body: 'Claude: Operant · Claude needs your permission to use Bash',
    })
  })
  it('falls back to a plain line when there is no text', () => {
    expect(notifyCopy({ kind: 'finished', name: 'P', detail: '' }).body).toBe('P · Finished its turn')
    expect(notifyCopy({ kind: 'needs', name: 'P', detail: '' }).body).toBe('P · Waiting for you')
  })
})
