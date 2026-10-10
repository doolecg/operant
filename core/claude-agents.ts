import { mkdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import type { ClaudePhase, ClaudeSessionState, ClaudeSessionStatus, ClaudeSubagent, ClaudeTileState, SubagentStatus, SubagentTokens } from '../shared/claude-mods'
import { isSafeSessionId, parseEventLine, parseStatusFile, type ClaudeEvent } from './claude-events'
import { JsonlTail, parseLine, transcriptProjectDir } from './transcripts'

// Per-tile Claude Code state from the events folder (hooks) and the status file. Nothing polls: the events folder is
// watched, and each change reads only the bytes appended since the last read.

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// What a sub-agent's tool result says about how it ended. Anything else leaves the status alone.
const RESULT_STATUS: Record<string, SubagentStatus> = {
  completed: 'completed',
  complete: 'completed',
  failed: 'failed',
  error: 'failed',
  stopped: 'stopped',
  killed: 'stopped',
  cancelled: 'stopped',
}

export interface AgentsState {
  sessionId: string | null
  agents: Map<string, ClaudeSubagent>
  // Transcript paths the hooks named (SubagentStop), by agent id.
  transcriptPaths: Map<string, string>
  // Agent tool calls' descriptions, by tool_use_id, until the result names the agent.
  descriptions: Map<string, string>
}

export const emptyAgents = (sessionId: string | null = null): AgentsState => ({
  sessionId,
  agents: new Map(),
  transcriptPaths: new Map(),
  descriptions: new Map(),
})

function ensureAgent(s: AgentsState, id: string): ClaudeSubagent {
  let a = s.agents.get(id)
  if (!a) {
    a = { agentId: id, agentType: null, status: 'unknown' }
    s.agents.set(id, a)
  }
  return a
}

// Applies one hook event to a session's sub-agents. Returns true when it could have changed something visible.
// Statuses come only from events: SubagentStart -> running, SubagentStop -> completed, a tool result's status or
// is_error -> failed/stopped/completed, and a PTY exit -> unknown (see endAgents).
export function reduceEvent(s: AgentsState, ev: ClaudeEvent): boolean {
  const p = ev.payload
  switch (ev.name) {
    case 'SessionStart':
      s.sessionId = ev.sessionId
      return true
    case 'SubagentStart': {
      const id = str(p.agent_id)
      if (!id || s.agents.has(id)) return false
      s.agents.set(id, { agentId: id, agentType: str(p.agent_type) ?? null, status: 'running', startedAt: ev.ts || undefined })
      return true
    }
    case 'SubagentStop': {
      const id = str(p.agent_id)
      if (!id) return false
      const a = ensureAgent(s, id)
      if (a.agentType === null) a.agentType = str(p.agent_type) ?? null
      const transcript = str(p.agent_transcript_path)
      if (transcript) s.transcriptPaths.set(id, transcript)
      if (a.status === 'running' || a.status === 'unknown') a.status = 'completed'
      if (ev.ts) a.endedAt ??= ev.ts
      return true
    }
    case 'PreToolUse': {
      if (p.tool_name !== 'Agent') return false
      const toolUseId = str(p.tool_use_id)
      const description = str(obj(p.tool_input).description)
      if (toolUseId && description) s.descriptions.set(toolUseId, description)
      return false
    }
    case 'PostToolUse': {
      if (p.tool_name !== 'Agent') return false
      const resp = obj(p.tool_response)
      const id = str(resp.agentId) ?? str(resp.agent_id)
      if (!id) return false
      const a = ensureAgent(s, id)
      const description = s.descriptions.get(str(p.tool_use_id) ?? '')
      if (description) a.description ??= description
      const model = str(resp.resolvedModel)
      if (model) a.model = model
      const mapped = resp.is_error === true ? 'failed' : RESULT_STATUS[str(resp.status) ?? '']
      if (mapped && (a.status === 'running' || a.status === 'unknown' || (a.status === 'completed' && mapped !== 'completed'))) {
        a.status = mapped
        if (ev.ts) a.endedAt ??= ev.ts
      }
      return true
    }
    default:
      return false
  }
}

// The PTY exited: sub-agents still running have no evidence of how they ended.
export function endAgents(s: AgentsState, ts: number): boolean {
  let changed = false
  for (const a of s.agents.values()) {
    if (a.status !== 'running') continue
    a.status = 'unknown'
    if (ts) a.endedAt ??= ts
    changed = true
  }
  return changed
}

// Sums one sub-agent transcript incrementally. Each API message is written once per content block, so lines are
// keyed by message id. Cost is estimated from pricing.ts and only when every message's model has a price.
export class SubagentUsage {
  private readonly tail: JsonlTail
  private readonly seen = new Set<string>()
  private readonly tokens: SubagentTokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }
  private model: string | undefined
  private costUsd = 0
  private unpriced = false
  private any = false
  // Context size of the latest request (input + cache read + cache write), i.e. what the sub-agent's window holds.
  private lastContext: number | undefined

  constructor(file: string) {
    this.tail = new JsonlTail(file)
  }

  // Reads what was appended; true when a new message was counted.
  read(): boolean {
    let changed = false
    for (const line of this.tail.read()) {
      const m = parseLine(line)
      if (!m || this.seen.has(m.messageId)) continue
      this.seen.add(m.messageId)
      this.tokens.input += m.inputTokens
      this.tokens.output += m.outputTokens
      this.tokens.cacheRead += m.cacheReadTokens
      this.tokens.cacheCreate += m.cacheWrite5mTokens + m.cacheWrite1hTokens
      this.model = m.model
      this.costUsd += m.costUsd
      this.unpriced ||= m.unpriced
      this.lastContext = m.inputTokens + m.cacheReadTokens + m.cacheWrite5mTokens + m.cacheWrite1hTokens
      this.any = true
      changed = true
    }
    return changed
  }

  // Writes the totals onto the sub-agent; leaves fields out when nothing was read or the model is unknown.
  applyTo(a: ClaudeSubagent): void {
    if (!this.any) return
    a.tokens = { ...this.tokens }
    if (this.lastContext !== undefined) a.contextTokens = this.lastContext
    a.model ??= this.model
    if (!this.unpriced && this.model) {
      a.costUsd = Math.round(this.costUsd * 1e6) / 1e6
      a.costEstimated = true
    }
  }
}

// ---- Main session (the session block of ClaudeTileState) ----

export const emptySession = (sessionId: string | null = null, cwd: string | null = null): ClaudeSessionState => ({
  phase: 'unknown',
  lastActivityAt: null,
  cwd,
  sessionId,
})

// A copy the snapshot can hand out without sharing objects with the reducer.
export const cloneSession = (s: ClaudeSessionState): ClaudeSessionState => ({ ...s, ...(s.waiting ? { waiting: { ...s.waiting } } : {}) })

// Applies one hook event to the main session. The phase comes only from events: SessionStart is idle, a prompt or a tool
// use is working, a Notification is waiting with its message, Stop ends the turn (idle), and SessionEnd (or the PTY
// exiting) is done. Returns true when something changed.
export function reduceSession(s: ClaudeSessionState, ev: ClaudeEvent): boolean {
  const p = ev.payload
  switch (ev.name) {
    case 'SessionStart':
      s.phase = 'idle'
      s.sessionId = ev.sessionId
      s.cwd = str(p.cwd) ?? s.cwd
      break
    case 'UserPromptSubmit':
    case 'PreToolUse':
      s.phase = 'working'
      delete s.waiting
      break
    case 'Notification':
      s.phase = 'waiting'
      s.waiting = { type: str(p.notification_type) ?? null, message: str(p.message) ?? null, at: ev.ts }
      break
    case 'Stop':
      s.phase = 'idle'
      delete s.waiting
      break
    case 'SessionEnd':
      endSession(s)
      break
    default:
      return false
  }
  if (ev.ts) s.lastActivityAt = ev.ts
  return true
}

// The PTY exited or the session ended: nothing more can be waiting.
export function endSession(s: ClaudeSessionState, phase: ClaudePhase = 'done'): void {
  s.phase = phase
  delete s.waiting
}

interface TileRecord {
  tileId: number
  cwd: string
  sessionId: string
  ptyRunning: boolean
  agents: AgentsState
  status: ClaudeSessionStatus | null
  session: ClaudeSessionState
  usage: Map<string, SubagentUsage>
  updatedAt: number
}

export interface ClaudeAgentsOptions {
  // <userData>/events, where the hooks write.
  eventsDir: string
  // Receives the tile's state after each change.
  emit: (state: ClaudeTileState) => void
  now?: () => number
  // Test seam for fs.watch: returns a closer. Watch errors are swallowed; the state then updates on the next start.
  watch?: (dir: string, onChange: (file: string | null) => void) => { close(): void }
}

const defaultWatch = (dir: string, onChange: (file: string | null) => void): { close(): void } => {
  const w = watch(dir, { persistent: false }, (_event, file) => onChange(file ? String(file) : null))
  w.on('error', () => undefined)
  return w
}

const FILE_RE = /^(status-)?(.+)\.(jsonl|json)$/

export class ClaudeAgents {
  private readonly tiles = new Map<number, TileRecord>()
  private readonly sessionTile = new Map<string, number>()
  private readonly tails = new Map<string, JsonlTail>()
  private watcher: { close(): void } | null = null
  private readonly startedAt: number
  private closed = false

  constructor(private readonly opts: ClaudeAgentsOptions) {
    this.startedAt = (opts.now ?? Date.now)()
  }

  private get clock(): number {
    return (this.opts.now ?? Date.now)()
  }

  // A tile started a Claude session. History already in the session's events file belongs to an earlier run and is skipped.
  begin(tileId: number, sessionId: string, cwd: string): void {
    if (!isSafeSessionId(sessionId)) return
    this.closed = false
    this.dropRecord(tileId)
    const rec: TileRecord = {
      tileId,
      cwd,
      sessionId,
      ptyRunning: true,
      agents: emptyAgents(sessionId),
      status: null,
      session: emptySession(sessionId, cwd),
      usage: new Map(),
      updatedAt: this.clock,
    }
    this.tiles.set(tileId, rec)
    this.sessionTile.set(sessionId, tileId)
    const tail = new JsonlTail(join(this.opts.eventsDir, `${sessionId}.jsonl`))
    tail.read()
    this.tails.set(sessionId, tail)
    this.ensureWatcher()
    this.publish(rec)
  }

  // The tile's PTY exited: flushes the events it wrote, marks running sub-agents unknown and stops watching its transcripts.
  end(tileId: number): void {
    const rec = this.tiles.get(tileId)
    if (!rec || !rec.ptyRunning) return
    this.readEvents(rec.sessionId)
    this.refreshUsage(rec)
    rec.ptyRunning = false
    rec.usage.clear()
    endAgents(rec.agents, this.clock)
    endSession(rec.session)
    rec.updatedAt = this.clock
    this.tails.delete(rec.sessionId)
    this.publish(rec)
    if (![...this.tiles.values()].some((r) => r.ptyRunning)) this.closeWatcher()
  }

  // A Chat view tile waits for a prompt it shows itself (the Notification hook does not fire for stdio prompts).
  setWaiting(tileId: number, w: { type: string; message: string }): void {
    const rec = this.tiles.get(tileId)
    if (!rec) return
    rec.session.phase = 'waiting'
    rec.session.waiting = { type: w.type, message: w.message, at: this.clock }
    rec.updatedAt = this.clock
    this.publish(rec)
  }

  clearWaiting(tileId: number): void {
    const rec = this.tiles.get(tileId)
    if (!rec || !rec.session.waiting) return
    delete rec.session.waiting
    rec.session.phase = 'working'
    rec.updatedAt = this.clock
    this.publish(rec)
  }

  get(tileId: number): ClaudeTileState | null {
    const rec = this.tiles.get(tileId)
    return rec ? this.snapshot(rec) : null
  }

  // Stops the watcher and forgets every tile (Claude mods were switched off, or the app is quitting). Events that
  // still arrive from running tiles are ignored until the next begin().
  dispose(): void {
    this.closeWatcher()
    this.tiles.clear()
    this.sessionTile.clear()
    this.tails.clear()
    this.closed = true
  }

  // Called by the watcher (or with null when the platform does not say which file changed: everything is read).
  onFile(file: string | null): void {
    if (this.closed) return
    if (file === null) {
      for (const sid of [...this.tails.keys()]) this.readEvents(sid)
      for (const rec of this.tiles.values()) this.readStatus(rec.sessionId)
      return
    }
    const m = FILE_RE.exec(file)
    if (!m || !isSafeSessionId(m[2])) return
    if (m[1]) this.readStatus(m[2])
    else this.readEvents(m[2])
  }

  private ensureWatcher(): void {
    if (this.watcher || this.closed) return
    try {
      mkdirSync(this.opts.eventsDir, { recursive: true })
      this.watcher = (this.opts.watch ?? defaultWatch)(this.opts.eventsDir, (file) => this.onFile(file))
    } catch {
      this.watcher = null
    }
  }

  private closeWatcher(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private readEvents(sessionId: string): void {
    let tail = this.tails.get(sessionId)
    if (!tail) {
      // A session Operant has not begun (e.g. /clear inside a tile): only events from this run and from a tile count.
      tail = new JsonlTail(join(this.opts.eventsDir, `${sessionId}.jsonl`))
      this.tails.set(sessionId, tail)
    }
    const changed = new Set<TileRecord>()
    for (const line of tail.read()) {
      const ev = parseEventLine(line)
      if (!ev) continue
      const rec = this.recordFor(ev)
      if (!rec) continue
      if (reduceEvent(rec.agents, ev)) changed.add(rec)
      if (reduceSession(rec.session, ev)) changed.add(rec)
      if (rec.agents.sessionId === ev.sessionId) this.refreshUsage(rec)
      rec.updatedAt = ev.ts || this.clock
    }
    for (const rec of changed) this.publish(rec)
  }

  // The tile an event belongs to: its OPERANT_TILE_ID tag, else the tile already mapped to the session.
  private recordFor(ev: ClaudeEvent): TileRecord | null {
    const tileId = ev.tile ?? this.sessionTile.get(ev.sessionId) ?? null
    if (tileId === null) return null
    if (ev.tile !== null) this.sessionTile.set(ev.sessionId, ev.tile)
    // Events from before this app run are an earlier session's history.
    const fresh = ev.ts >= this.startedAt
    let rec = this.tiles.get(tileId)
    if (!rec) {
      if (!fresh) return null
      rec = { tileId, cwd: str(ev.payload.cwd) ?? '', sessionId: ev.sessionId, ptyRunning: true, agents: emptyAgents(), status: null, session: emptySession(ev.sessionId, str(ev.payload.cwd) ?? null), usage: new Map(), updatedAt: ev.ts }
      this.tiles.set(tileId, rec)
    }
    if (rec.sessionId !== ev.sessionId) {
      // A new session on the same tile (e.g. /clear) starts with SessionStart; anything else from it is not ours.
      if (!fresh || ev.name !== 'SessionStart') return null
      rec.usage.clear()
      rec.sessionId = ev.sessionId
      rec.agents = emptyAgents(ev.sessionId)
      rec.status = null
      rec.session = emptySession(ev.sessionId, str(ev.payload.cwd) ?? (rec.cwd || null))
      if (!rec.cwd) rec.cwd = str(ev.payload.cwd) ?? ''
    }
    return rec
  }

  private readStatus(sessionId: string): void {
    const tileId = this.sessionTile.get(sessionId)
    const rec = tileId === undefined ? undefined : this.tiles.get(tileId)
    if (!rec || rec.sessionId !== sessionId) return
    let text: string
    try {
      text = readFileSync(join(this.opts.eventsDir, `status-${sessionId}.json`), 'utf8')
    } catch {
      return
    }
    const status = parseStatusFile(text)
    if (!status) return
    rec.status = status
    rec.updatedAt = status.updatedAt || this.clock
    this.refreshUsage(rec)
    this.publish(rec)
  }

  // Reads each known sub-agent transcript's new bytes into its totals. Transcripts are looked up under the tile's cwd.
  private refreshUsage(rec: TileRecord): void {
    if (!rec.cwd) return
    for (const a of rec.agents.agents.values()) {
      let reader = rec.usage.get(a.agentId)
      if (!reader) {
        const file = rec.agents.transcriptPaths.get(a.agentId) ?? join(transcriptProjectDir(rec.cwd), rec.sessionId, 'subagents', `agent-${a.agentId}.jsonl`)
        reader = new SubagentUsage(file)
        rec.usage.set(a.agentId, reader)
      }
      reader.read()
      reader.applyTo(a)
    }
  }

  private dropRecord(tileId: number): void {
    const old = this.tiles.get(tileId)
    if (old) {
      this.tails.delete(old.sessionId)
      this.sessionTile.delete(old.sessionId)
    }
    this.tiles.delete(tileId)
  }

  private snapshot(rec: TileRecord): ClaudeTileState {
    return {
      tileId: rec.tileId,
      sessionId: rec.sessionId,
      ptyRunning: rec.ptyRunning,
      subagents: [...rec.agents.agents.values()].map((a) => ({ ...a, ...(a.tokens ? { tokens: { ...a.tokens } } : {}) })),
      status: rec.status ? { ...rec.status } : null,
      session: cloneSession(rec.session),
      updatedAt: rec.updatedAt,
    }
  }

  // The tile's state, then the cross-tile summaries, to the listeners.
  private publish(rec: TileRecord): void {
    this.opts.emit(this.snapshot(rec))
  }
}
