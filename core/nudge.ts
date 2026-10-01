import type { AgentKind } from '../shared/types'

export const CLEAR_LINE = '/clear'
export const EXIT_LINE = '/exit'

export const nudgeLine = (unread: number): string =>
  `Operant: you have ${unread} unread ${unread === 1 ? 'message' : 'messages'}. Run: operant inbox`

const NUDGE_RE = /^Operant: you have \d+ unread messages?\. Run: operant inbox$/

// The only lines Operant ever types into an agent's PTY on its own (launch commands excepted).
export const isFixedLine = (line: string): boolean => line === CLEAR_LINE || line === EXIT_LINE || NUDGE_RE.test(line)

export interface NudgeConfig {
  nudgeIdleSeconds: number
  nudgeBatchSeconds: number
  renudgeSeconds: number
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = { nudgeIdleSeconds: 5, nudgeBatchSeconds: 15, renudgeSeconds: 120 }

export interface NudgeOperatorState {
  key: number | string
  agent: AgentKind
  // Null when the session is not running.
  idleMs: number | null
  unread: number
  // Created time of the newest unread message (ms).
  newestUnreadAt: number
  // An unread message from the user or the Master Terminal skips the batch delay.
  urgent?: boolean
  // Paused by a spend cap: no nudges and no /clear.
  paused?: boolean
  clearBetweenJobs?: boolean
  hasDoingJob?: boolean
  // When a job last finished for this operator; a /clear is sent once per finish.
  jobFinishedAt?: number
}

export interface NudgeAction {
  key: number | string
  kind: 'nudge' | 'clear'
  line: string
}

interface NudgeRecord {
  at: number
}

// Pure and clock-driven: the caller supplies `now` and the current state, then types each returned
// action with SessionManager.typeFixed. Agents other than Claude (shell, Codex by ruling R3) get nothing.
export class NudgeScheduler {
  private readonly nudged = new Map<number | string, NudgeRecord>()
  private readonly cleared = new Map<number | string, number>()

  constructor(private config: NudgeConfig = DEFAULT_NUDGE_CONFIG) {}

  setConfig(config: Partial<NudgeConfig>): void {
    this.config = { ...this.config, ...config }
  }

  forget(key: number | string): void {
    this.nudged.delete(key)
    this.cleared.delete(key)
  }

  tick(now: number, operators: NudgeOperatorState[]): NudgeAction[] {
    const actions: NudgeAction[] = []
    for (const op of operators) {
      if (op.unread <= 0) this.nudged.delete(op.key)
      if (op.agent !== 'claude' || op.idleMs === null || op.paused) continue
      if (op.idleMs < this.config.nudgeIdleSeconds * 1000) continue

      if (op.clearBetweenJobs && !op.hasDoingJob && op.jobFinishedAt !== undefined && op.jobFinishedAt > (this.cleared.get(op.key) ?? -Infinity)) {
        this.cleared.set(op.key, op.jobFinishedAt)
        actions.push({ key: op.key, kind: 'clear', line: CLEAR_LINE })
        continue
      }

      if (op.unread <= 0) continue
      if (!op.urgent && now - op.newestUnreadAt < this.config.nudgeBatchSeconds * 1000) continue
      const last = this.nudged.get(op.key)
      const newBatch = !last || op.newestUnreadAt > last.at
      const stale = last !== undefined && now - last.at >= this.config.renudgeSeconds * 1000
      if (!newBatch && !stale) continue
      this.nudged.set(op.key, { at: now })
      actions.push({ key: op.key, kind: 'nudge', line: nudgeLine(op.unread) })
    }
    return actions
  }
}
