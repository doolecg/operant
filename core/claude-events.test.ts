import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MOD_DEFAULT_ENABLED, type ModId } from '../shared/claude-mods'
import { claudeModsConfig, modsCommand, parseEventLine, parseStatusFile } from './claude-events'

const SCRIPT = resolve(process.cwd(), 'scripts', 'op-event.mjs')
const SID = '11111111-2222-4333-8444-555555555555'
const paths = { node: 'C:\\Program Files\\Operant 3\\Operant 3.exe', script: 'C:\\app\\scripts\\op-event.mjs', eventsDir: 'C:\\Users\\Dayle Frost\\AppData\\Roaming\\Operant2\\events' }

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

const mods = (on: Partial<Record<ModId, boolean>> = {}) => ({ ...MOD_DEFAULT_ENABLED, ...on })

describe('Claude mods config', () => {
  it('is null when Claude mods are off', () => {
    expect(claudeModsConfig(paths, { enabled: false, mods: mods({ subagents: true }), keepWarm: true, commandMenu: true })).toBeNull()
  })

  it('registers the session and sub-agent events, and the Agent matcher, while the subagents mod is on', () => {
    const cfg = claudeModsConfig(paths, { enabled: true, mods: mods({ subagents: true }), keepWarm: true, commandMenu: true })!
    expect(Object.keys(cfg.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'])
    expect(cfg.hooks.PreToolUse).toEqual([{ matcher: 'Agent', hooks: [{ type: 'command', command: expect.any(String) }] }])
    expect(cfg.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: expect.any(String) }] }])
    expect(cfg.statusLine).toEqual({ type: 'command', command: expect.stringContaining(' status ') })
  })

  it('registers no hooks for the native mods alone, but keeps the status line', () => {
    const cfg = claudeModsConfig(paths, { enabled: true, mods: mods({ subagents: false, folderTracker: true }), keepWarm: true, commandMenu: true })!
    expect(cfg.hooks).toEqual({})
    expect(cfg.statusLine.command).toContain(' status ')
  })

  it('quotes the command with forward slashes and the events folder, and refuses unsafe paths', () => {
    const cmd = modsCommand(paths, 'hook')!
    expect(cmd).toBe(
      'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Operant 3/Operant 3.exe" "C:/app/scripts/op-event.mjs" hook "C:/Users/Dayle Frost/AppData/Roaming/Operant2/events"',
    )
    expect(modsCommand({ ...paths, eventsDir: 'C:/a$b' }, 'hook')).toBeNull()
    expect(claudeModsConfig({ ...paths, script: 'C:/x"y.mjs' }, { enabled: true, mods: mods({ subagents: true }), keepWarm: true, commandMenu: true })).toBeNull()
  })
})

describe('event and status parsing', () => {
  it('reads a hook line with its tile tag and session id', () => {
    const e = parseEventLine(JSON.stringify({ ts: 5, tile: '7', hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'x' }))
    expect(e).toMatchObject({ ts: 5, tile: 7, sessionId: SID, name: 'SubagentStop' })
    expect(e?.payload.agent_id).toBe('x')
  })

  it('rejects lines that are not events Operant can use', () => {
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine(JSON.stringify({ hook_event_name: 'Stop', session_id: '../evil' }))).toBeNull()
    expect(parseEventLine(JSON.stringify({ session_id: SID }))).toBeNull()
    expect(parseEventLine(JSON.stringify({ hook_event_name: 'Stop', session_id: SID, tile: null }))?.tile).toBeNull()
  })

  it('reduces a status payload to the fields it has', () => {
    const s = parseStatusFile(
      JSON.stringify({
        ts: 9,
        model: { id: 'claude-opus-5-5', display_name: 'Opus' },
        context_window: { context_window_size: 200000, used_percentage: 12.5, current_usage: { input_tokens: 3, cache_read_input_tokens: 40 } },
        cost: { total_cost_usd: 0.42, total_duration_ms: 1000 },
      }),
    )
    expect(s).toEqual({
      model: 'Opus',
      contextWindowSize: 200000,
      usedPercentage: 12.5,
      currentUsage: { inputTokens: 3, cacheReadTokens: 40 },
      costUsd: 0.42,
      durationMs: 1000,
      updatedAt: 9,
    })
    expect(parseStatusFile('{"model":{}}')).toEqual({ updatedAt: 0 })
    expect(parseStatusFile('oops')).toBeNull()
  })
})

describe('op-event.mjs', () => {
  function run(mode: string, input: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'op-event-'))
    dirs.push(dir)
    const events = join(dir, 'events')
    const res = spawnSync(process.execPath, [SCRIPT, mode, events], {
      input,
      env: { PATH: process.env.PATH ?? '', OPERANT_SOURCE: 'operant', OPERANT_TILE_ID: '7', ...env },
      encoding: 'utf8',
    })
    return { res, events }
  }

  it('appends a tagged hook line to the session file and drops prompts', () => {
    const payload = { session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Map', prompt: 'private' } }
    const { res, events } = run('hook', JSON.stringify(payload))
    expect(res.status).toBe(0)
    const lines = readFileSync(join(events, `${SID}.jsonl`), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const line = JSON.parse(lines[0]!)
    expect(line).toMatchObject({ tile: '7', hook_event_name: 'PreToolUse', tool_input: { description: 'Map' } })
    expect(typeof line.ts).toBe('number')
    expect(line.tool_input).not.toHaveProperty('prompt')
  })

  it('writes the latest status and prints one line', () => {
    const payload = { session_id: SID, model: { display_name: 'Haiku' }, context_window: { used_percentage: 30 }, cost: { total_cost_usd: 0.1 } }
    const { res, events } = run('status', JSON.stringify(payload))
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('Haiku | ctx 30% | $0.10')
    expect(JSON.parse(readFileSync(join(events, `status-${SID}.json`), 'utf8'))).toMatchObject({ tile: '7', model: { display_name: 'Haiku' } })
  })

  it('writes nothing outside Operant tiles and exits 0 on bad input', () => {
    const { res, events } = run('hook', JSON.stringify({ session_id: SID, hook_event_name: 'Stop' }), { OPERANT_SOURCE: '' })
    expect(res.status).toBe(0)
    expect(existsSync(events)).toBe(false)
    const bad = run('hook', 'not json')
    expect(bad.res.status).toBe(0)
    expect(existsSync(bad.events)).toBe(false)
  })
})
