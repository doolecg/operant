import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeSubagent, ClaudeTileState } from '../shared/claude-mods'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ClaudeAgents, emptySession, endSession, emptyAgents, endAgents, reduceEvent, reduceSession, SubagentUsage } from './claude-agents'
import { parseEventLine, type ClaudeEvent } from './claude-events'

const SID = '11111111-2222-4333-8444-555555555555'
const AGENT = 'a1b2c3'

let dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'op-agents-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

const ev = (name: string, payload: Record<string, unknown> = {}, ts = 1000): ClaudeEvent => ({
  ts,
  tile: null,
  sessionId: SID,
  name,
  payload: { hook_event_name: name, session_id: SID, ...payload },
})

describe('sub-agent state reduction', () => {
  it('goes running on start and completed on stop, keeping the type', () => {
    const s = emptyAgents(SID)
    reduceEvent(s, ev('SubagentStart', { agent_id: AGENT, agent_type: 'Explore' }, 1000))
    expect([...s.agents.values()]).toEqual([{ agentId: AGENT, agentType: 'Explore', status: 'running', startedAt: 1000 }])
    reduceEvent(s, ev('SubagentStop', { agent_id: AGENT, agent_type: 'Explore' }, 2000))
    expect(s.agents.get(AGENT)).toMatchObject({ status: 'completed', endedAt: 2000, agentType: 'Explore' })
  })

  it('takes the model and description from the Agent tool calls', () => {
    const s = emptyAgents(SID)
    reduceEvent(s, ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'Map the repo', prompt: 'secret text' } }))
    reduceEvent(s, ev('SubagentStart', { agent_id: AGENT, agent_type: 'Explore' }))
    reduceEvent(s, ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_response: { agentId: AGENT, status: 'completed', resolvedModel: 'claude-haiku-4-5' } }, 3000))
    expect(s.agents.get(AGENT)).toMatchObject({ description: 'Map the repo', model: 'claude-haiku-4-5', status: 'completed', endedAt: 3000 })
  })

  it('marks a failed tool result as failed, even after a stop event', () => {
    const s = emptyAgents(SID)
    reduceEvent(s, ev('SubagentStart', { agent_id: AGENT }))
    reduceEvent(s, ev('SubagentStop', { agent_id: AGENT }, 2000))
    reduceEvent(s, ev('PostToolUse', { tool_name: 'Agent', tool_response: { agentId: AGENT, is_error: true } }, 2500))
    expect(s.agents.get(AGENT)?.status).toBe('failed')
  })

  it('leaves the status unknown when a result names no status', () => {
    const s = emptyAgents(SID)
    reduceEvent(s, ev('PostToolUse', { tool_name: 'Agent', tool_response: { agentId: AGENT } }))
    expect(s.agents.get(AGENT)).toMatchObject({ status: 'unknown', agentType: null })
  })

  it('ignores other tools and events without an agent id', () => {
    const s = emptyAgents(SID)
    expect(reduceEvent(s, ev('PostToolUse', { tool_name: 'Bash', tool_response: { agentId: AGENT, status: 'failed' } }))).toBe(false)
    expect(reduceEvent(s, ev('SubagentStart', {}))).toBe(false)
    expect(s.agents.size).toBe(0)
  })

  it('marks running sub-agents unknown when the PTY exits and keeps finished ones', () => {
    const s = emptyAgents(SID)
    reduceEvent(s, ev('SubagentStart', { agent_id: 'run' }))
    reduceEvent(s, ev('SubagentStart', { agent_id: 'done' }))
    reduceEvent(s, ev('SubagentStop', { agent_id: 'done' }, 1500))
    expect(endAgents(s, 4000)).toBe(true)
    expect(s.agents.get('run')).toMatchObject({ status: 'unknown', endedAt: 4000 })
    expect(s.agents.get('done')).toMatchObject({ status: 'completed', endedAt: 1500 })
  })
})

describe('sub-agent transcript usage', () => {
  const line = (id: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T10:00:00Z', message: { id, model, usage, content: [{ type: 'text', text: 'x' }] } })

  it('sums each message once and estimates the cost from the price table', () => {
    const dir = tmp()
    const file = join(dir, 'agent-a1b2c3.jsonl')
    writeFileSync(
      file,
      [
        line('m1', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
        // The same message again (one line per content block): counted once.
        line('m1', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
        line('m2', 'claude-haiku-4-5', { input_tokens: 50, output_tokens: 5 }),
        'not json',
      ].join('\n') + '\n',
    )
    const usage = new SubagentUsage(file)
    expect(usage.read()).toBe(true)
    const a: ClaudeSubagent = { agentId: AGENT, agentType: null, status: 'completed' }
    usage.applyTo(a)
    expect(a).toMatchObject({ model: 'claude-haiku-4-5', tokens: { input: 150, output: 15, cacheRead: 1000, cacheCreate: 200 }, costEstimated: true })
    // Haiku 4.5 at $1 in, $5 out, $0.10 cache read: m1 = 500 per million tokens (0.0005), m2 = 75 (0.000075).
    expect(a.costUsd).toBeCloseTo(0.000575, 9)
  })

  it('reads only appended bytes and leaves cost out for an unpriced model', () => {
    const dir = tmp()
    const file = join(dir, 'agent.jsonl')
    writeFileSync(file, line('m1', 'mystery-model', { input_tokens: 10, output_tokens: 1 }) + '\n')
    const usage = new SubagentUsage(file)
    usage.read()
    appendFileSync(file, line('m2', 'mystery-model', { input_tokens: 5, output_tokens: 1 }) + '\n')
    expect(usage.read()).toBe(true)
    expect(usage.read()).toBe(false)
    const a: ClaudeSubagent = { agentId: AGENT, agentType: null, status: 'running' }
    usage.applyTo(a)
    expect(a.tokens).toEqual({ input: 15, output: 2, cacheRead: 0, cacheCreate: 0 })
    expect(a.costUsd).toBeUndefined()
  })

  it('leaves tokens out when the transcript is missing', () => {
    const usage = new SubagentUsage(join(tmp(), 'missing.jsonl'))
    expect(usage.read()).toBe(false)
    const a: ClaudeSubagent = { agentId: AGENT, agentType: null, status: 'running' }
    usage.applyTo(a)
    expect(a).not.toHaveProperty('tokens')
  })
})

describe('ClaudeAgents', () => {
  function setup(now = 500) {
    const eventsDir = join(tmp(), 'events')
    const emitted: ClaudeTileState[] = []
    const closed: string[] = []
    let onChange: ((file: string | null) => void) | null = null
    let t = now
    const agents = new ClaudeAgents({
      eventsDir,
      emit: (s) => emitted.push(s),
      now: () => t,
      watch: (dir, cb) => {
        closed.push(`watch:${dir}`)
        onChange = cb
        return { close: () => closed.push('closed') }
      },
    })
    return { agents, eventsDir, emitted, closed, fire: (f: string | null) => onChange?.(f), setNow: (n: number) => (t = n) }
  }

  const write = (dir: string, file: string, obj: Record<string, unknown>) => {
    appendFileSync(join(dir, file), `${JSON.stringify(obj)}\n`)
  }
  const hook = (name: string, extra: Record<string, unknown> = {}, ts = 600) => ({ ts, tile: '7', hook_event_name: name, session_id: SID, cwd: 'C:/nowhere', ...extra })

  it('tracks a tile from its events file, incrementally, and emits each change', () => {
    const { agents, eventsDir, fire, setNow } = setup()
    setNow(600)
    agents.begin(7, SID, '')
    mkdirIfMissing(eventsDir)
    write(eventsDir, `${SID}.jsonl`, hook('SessionStart'))
    write(eventsDir, `${SID}.jsonl`, hook('SubagentStart', { agent_id: AGENT, agent_type: 'Explore' }))
    fire(`${SID}.jsonl`)
    let s = agents.get(7)!
    expect(s).toMatchObject({ tileId: 7, sessionId: SID, ptyRunning: true, status: null })
    expect(s.subagents).toEqual([{ agentId: AGENT, agentType: 'Explore', status: 'running', startedAt: 600 }])

    write(eventsDir, `${SID}.jsonl`, hook('SubagentStop', { agent_id: AGENT, agent_type: 'Explore' }, 700))
    fire(`${SID}.jsonl`)
    s = agents.get(7)!
    expect(s.subagents[0]).toMatchObject({ status: 'completed', endedAt: 700 })
  })

  it('reads the status file on its own change, with only the fields it has', () => {
    const { agents, eventsDir, fire, setNow } = setup()
    setNow(600)
    agents.begin(7, SID, '')
    mkdirIfMissing(eventsDir)
    writeFileSync(join(eventsDir, `status-${SID}.json`), JSON.stringify({ ts: 650, tile: '7', session_id: SID, model: { display_name: 'Opus' }, context_window: { used_percentage: 42 } }))
    fire(`status-${SID}.json`)
    expect(agents.get(7)?.status).toEqual({ model: 'Opus', usedPercentage: 42, updatedAt: 650 })
  })

  it('skips the history of a session it begins and ignores events from earlier runs', () => {
    const { agents, eventsDir, fire, setNow, emitted } = setup(500)
    mkdirIfMissing(eventsDir)
    write(eventsDir, `${SID}.jsonl`, hook('SubagentStart', { agent_id: 'old' }, 100))
    setNow(600)
    agents.begin(7, SID, '')
    write(eventsDir, `${SID}.jsonl`, hook('SubagentStart', { agent_id: 'new' }, 610))
    write(eventsDir, 'other-session.jsonl', { ts: 100, tile: '9', hook_event_name: 'SessionStart', session_id: 'other-session' })
    fire(null)
    expect(agents.get(7)?.subagents.map((a) => a.agentId)).toEqual(['new'])
    expect(agents.get(9)).toBeNull()
    expect(emitted.length).toBeGreaterThan(0)
  })

  it('maps a session by its OPERANT_TILE_ID tag when it was not begun here', () => {
    const { agents, eventsDir, setNow } = setup(500)
    setNow(900)
    mkdirIfMissing(eventsDir)
    write(eventsDir, `${SID}.jsonl`, hook('SessionStart', { ts: 950, cwd: 'C:/proj' }))
    write(eventsDir, `${SID}.jsonl`, hook('SubagentStart', { agent_id: AGENT, ts: 960 }))
    agents.onFile(`${SID}.jsonl`)
    expect(agents.get(7)).toMatchObject({ sessionId: SID, ptyRunning: true })
    expect(agents.get(7)?.subagents).toHaveLength(1)
  })

  it('marks running sub-agents unknown when the tile ends and closes the watcher', () => {
    const { agents, eventsDir, fire, setNow, closed, emitted } = setup()
    setNow(600)
    agents.begin(7, SID, '')
    mkdirIfMissing(eventsDir)
    write(eventsDir, `${SID}.jsonl`, hook('SubagentStart', { agent_id: AGENT }, 700))
    fire(`${SID}.jsonl`)
    agents.end(7)
    const s = agents.get(7)!
    expect(s.ptyRunning).toBe(false)
    expect(s.subagents[0]).toMatchObject({ status: 'unknown', endedAt: 600 })
    expect(closed).toContain('closed')
    expect(emitted.at(-1)?.ptyRunning).toBe(false)
  })

  it('stops watching on dispose and returns nothing for unknown tiles', () => {
    const { agents, closed } = setup()
    agents.begin(3, SID, '')
    agents.dispose()
    expect(closed).toContain('closed')
    expect(agents.get(3)).toBeNull()
  })

  it('keeps the events folder watcher off until a tile begins', () => {
    const { agents, closed } = setup()
    expect(closed).toEqual([])
    agents.begin(1, SID, '')
    expect(closed.filter((c) => c.startsWith('watch:'))).toHaveLength(1)
  })
})

function mkdirIfMissing(dir: string) {
  mkdirSync(dir, { recursive: true })
}

describe('main session phase', () => {
  // The fixture is the hook events of one tile, as op-event.mjs writes them.
  const events = readFileSync(resolve(import.meta.dirname, 'fixtures', 'claude-session.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseEventLine(l)!)

  it('follows the events: idle, working, waiting with the message, working, idle, done', () => {
    const s = emptySession()
    const phases = events.map((ev) => (reduceSession(s, ev), s.phase))
    expect(phases).toEqual(['idle', 'working', 'working', 'waiting', 'working', 'idle', 'done'])
  })

  it('keeps the notification message while waiting and clears it on the next prompt', () => {
    const s = emptySession()
    events.slice(0, 4).forEach((ev) => reduceSession(s, ev))
    expect(s.waiting).toEqual({ type: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: 1300 })
    reduceSession(s, events[4]!)
    expect(s.waiting).toBeUndefined()
    expect(s.lastActivityAt).toBe(1400)
  })

  it('records the session id and cwd from SessionStart, and is unknown before any event', () => {
    const s = emptySession()
    expect(s.phase).toBe('unknown')
    reduceSession(s, events[0]!)
    expect(s).toMatchObject({ phase: 'idle', cwd: 'C:/proj', sessionId: '11111111-2222-4333-8444-555555555555' })
  })

  it('ends as done when the PTY exits, whatever was waiting', () => {
    const s = emptySession()
    events.slice(0, 4).forEach((ev) => reduceSession(s, ev))
    endSession(s)
    expect(s).toMatchObject({ phase: 'done' })
    expect(s.waiting).toBeUndefined()
  })

  it('ignores events it does not read', () => {
    const s = emptySession()
    expect(reduceSession(s, { ts: 1, tile: 1, sessionId: 'x', name: 'PostToolUse', payload: {} })).toBe(false)
  })
})
