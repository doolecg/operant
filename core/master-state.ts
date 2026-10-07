import type { HookReport, MasterCli, MasterPhase, MasterState } from '../shared/types'

// Where each project's Master Terminal is, as far as the CLI tells us: not what the pty prints.
//   Claude:   the plugin hooks call `operant hook <event>` (SessionStart, UserPromptSubmit, Stop, Notification,
//             SubagentStart, SubagentStop), which reaches `hook()` here.
//   OpenCode: the background service's event stream (core/opencode.ts watchPhase) calls `phase()`.
// The gate (queue) types a fixed line only when `phase === 'idle'`. 'needs-input' is a permission prompt or a
// question dialog in the terminal: never type into it.
//
//   unknown --started()--> starting --SessionStart--> idle <--Stop-- busy <--UserPromptSubmit-- idle
//   busy --Notification(permission_prompt)--> needs-input --next prompt / Stop / subagent activity--> busy | idle
//   any --exited()--> exited

// Notification types that mean "the terminal is waiting for the owner".
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

export interface MasterStatesOptions {
  now?: () => number
  // A phase, session or agent count changed.
  onChange?: (state: MasterState, previous: MasterPhase) => void
  // A SessionStart reported a session id that differs from the one known (a /clear or a resume): usage re-attaches to it.
  onSession?: (crewId: number, sessionId: string, source: string) => void
}

export class MasterStates {
  private readonly states = new Map<number, MasterState>()
  private readonly now: () => number

  constructor(private readonly o: MasterStatesOptions = {}) {
    this.now = o.now ?? Date.now
  }

  get(crewId: number): MasterState {
    return this.states.get(crewId) ?? this.fresh(crewId, 'claude')
  }

  private fresh(crewId: number, cli: MasterCli): MasterState {
    return { crewId, phase: 'unknown', cli, sessionId: null, since: this.now(), lastEvent: '', lastPromptAt: null, lastStopAt: null, notificationType: '', notification: '', agents: 0 }
  }

  private set(crewId: number, patch: Partial<MasterState>, cli?: MasterCli): MasterState {
    const cur = this.states.get(crewId) ?? this.fresh(crewId, cli ?? 'claude')
    const next: MasterState = { ...cur, ...patch, ...(cli ? { cli } : {}) }
    if (next.phase !== cur.phase) next.since = this.now()
    this.states.set(crewId, next)
    const changed = next.phase !== cur.phase || next.sessionId !== cur.sessionId || next.agents !== cur.agents
    if (changed) this.o.onChange?.(next, cur.phase)
    return next
  }

  // The Master Terminal session was launched: waits for its first sign of life.
  started(crewId: number, cli: MasterCli, sessionId: string | null): MasterState {
    return this.set(crewId, { phase: 'starting', sessionId, since: this.now(), lastEvent: 'started', lastPromptAt: null, lastStopAt: null, notificationType: '', notification: '', agents: 0 }, cli)
  }

  // The session ended (pty exit).
  exited(crewId: number): MasterState {
    return this.set(crewId, { phase: 'exited', lastEvent: 'exited', agents: 0 })
  }

  // One hook report from the Claude Master.
  hook(crewId: number, r: HookReport): MasterState {
    const at = this.now()
    const base: Partial<MasterState> = { lastEvent: r.event }
    if (r.sessionId && r.event !== 'SubagentStart' && r.event !== 'SubagentStop') base.sessionId = r.sessionId
    const cur = this.get(crewId)
    // A late hook from a session that already exited changes nothing.
    if (cur.phase === 'exited') return cur
    // Claude also fires SubagentStart/Stop for its internal helpers; those carry no agent type and are not ours.
    if ((r.event === 'SubagentStart' || r.event === 'SubagentStop') && !r.agentType) return cur
    switch (r.event) {
      case 'SessionStart': {
        const known = cur.sessionId
        const next = this.set(crewId, { ...base, phase: 'idle', agents: 0, notification: '', notificationType: '' }, 'claude')
        if (r.sessionId && r.sessionId !== known) this.o.onSession?.(crewId, r.sessionId, r.source)
        return next
      }
      case 'UserPromptSubmit':
        return this.set(crewId, { ...base, phase: 'busy', lastPromptAt: at, notification: '', notificationType: '' }, 'claude')
      case 'Stop':
        // Stop can fire while a background subagent still runs (P0): the agent count stays until its SubagentStop.
        return this.set(crewId, { ...base, phase: 'idle', lastStopAt: at, notification: '', notificationType: '' }, 'claude')
      case 'Notification': {
        const waiting = WAITING_NOTIFICATIONS.has(r.notificationType)
        return this.set(crewId, { ...base, notification: r.message, notificationType: r.notificationType, ...(waiting ? { phase: 'needs-input' as const } : {}) }, 'claude')
      }
      case 'SubagentStart':
        return this.set(crewId, { ...base, phase: 'busy', agents: cur.agents + 1, notification: '', notificationType: '' }, 'claude')
      case 'SubagentStop':
        // Subagent work is activity: it also ends a permission wait.
        return this.set(crewId, { ...base, phase: cur.phase === 'needs-input' ? 'busy' : cur.phase, agents: Math.max(0, cur.agents - 1) }, 'claude')
    }
  }

  // The OpenCode Master's phase from the service event stream (or the polling fallback).
  phase(crewId: number, phase: 'idle' | 'busy' | 'needs-input', event = '', sessionId?: string): MasterState {
    const cur = this.get(crewId)
    if (cur.phase === 'exited') return cur
    // 'starting' ends with the first idle or busy sign from the service.
    return this.set(
      crewId,
      {
        phase,
        lastEvent: event || phase,
        ...(sessionId ? { sessionId } : {}),
        ...(phase === 'busy' ? { lastPromptAt: this.now() } : {}),
        ...(phase === 'idle' ? { lastStopAt: this.now() } : {}),
        ...(phase !== 'needs-input' ? { notification: '', notificationType: '' } : {}),
      },
      'opencode',
    )
  }

  // True when the gate may type a fixed line: the Master is idle and has no subagents running.
  canDeliver(crewId: number): boolean {
    const s = this.get(crewId)
    return s.phase === 'idle' && s.agents === 0
  }
}
