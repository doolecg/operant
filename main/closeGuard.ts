import type { BrowserWindow } from 'electron'
import type { Operant } from '../core/operant'
import { shouldConfirmAppClose, type RunningCounts } from '../shared/notify'
import { push } from './ipc'
import type { TurnWatch } from './notify'

// The renderer must confirm it is showing the dialog within this time, or the window closes as it would have anyway.
const SHOWN_MS = 3000

export interface CloseGuardDeps {
  operant: Operant
  turns: TurnWatch
  // Quitting, the OS ending the session, or an update install: never ask then.
  skip(): boolean
}

export interface CloseGuard {
  // The renderer's answer: 'shown' (dialog is up), 'quit' (confirmed) or 'stay' (cancelled).
  answer(action: 'shown' | 'quit' | 'stay'): void
}

// Closing the window while something runs asks the renderer to confirm. Nothing answered in time closes the window.
export function attachCloseGuard(win: BrowserWindow, deps: CloseGuardDeps): CloseGuard {
  let allowed = false
  let asking = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const closeNow = (): void => {
    allowed = true
    if (!win.isDestroyed()) win.close()
  }
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const counts = async (): Promise<RunningCounts> => {
    const out: RunningCounts = { claude: 0, opencode: 0, shell: 0, midTurn: false }
    for (const crew of await deps.operant.handlers['crews:list']()) {
      for (const s of await deps.operant.handlers['scratch:list'](crew.id)) {
        if (!(await deps.operant.handlers['scratch:status'](s.id)).running) continue
        if (s.agent === 'claude') out.claude++
        else if (s.agent === 'opencode') out.opencode++
        else if (s.agent === 'shell') out.shell++
        if (deps.turns.busy(s.id)) out.midTurn = true
      }
    }
    return out
  }

  win.on('close', (e) => {
    if (allowed || deps.skip()) return
    e.preventDefault()
    if (asking) return
    asking = true
    void counts()
      .catch((): RunningCounts => ({ claude: 0, opencode: 0, shell: 0, midTurn: false }))
      .then((c) => {
        if (win.isDestroyed()) return
        if (!shouldConfirmAppClose(deps.operant.currentSettings.confirm.closeApp, c)) {
          asking = false
          closeNow()
          return
        }
        push(win, 'app:closeRequest', c)
        timer = setTimeout(() => {
          timer = null
          asking = false
          closeNow()
        }, SHOWN_MS)
      })
  })

  return {
    answer(action) {
      if (action === 'shown') {
        clear()
        return
      }
      if (!asking) return
      clear()
      asking = false
      if (action === 'quit') closeNow()
    },
  }
}
