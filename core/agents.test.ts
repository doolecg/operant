import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubagentReader, type ReaderFs } from './agents'
import { Store } from './store'

const sep = (p: string) => p.replace(/\\/g, '/')

function memFs(files: Record<string, string>, mtime = 0): ReaderFs {
  const norm = Object.fromEntries(Object.entries(files).map(([k, v]) => [sep(k), v]))
  return {
    list: (dir) => {
      const d = sep(dir).replace(/\/$/, '') + '/'
      return Object.keys(norm).filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/')).map((k) => k.slice(d.length))
    },
    read: (f) => norm[sep(f)] ?? null,
    mtime: (f) => (sep(f) in norm ? mtime : null),
  }
}

const jl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n')

describe('subagent reader', () => {
  let store: Store
  let runId: number
  beforeEach(() => {
    store = new Store(':memory:')
    const crew = store.createCrew('shop', '/code/shop')
    runId = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude', teamId: null, seats: [], limits: { maxWorkers: 0, topTier: '', tokenBudget: 0 }, rules: '' }).id
  })
  afterEach(() => store.close())

  const dir = '/proj/-code-shop/sess1'
  const src = { cli: 'claude' as const, cwd: '/code/shop', sessionId: 'sess1' }
  const reader = (fs: ReaderFs, now = () => 1000) => new SubagentReader({ store, fs, projectsDir: () => '/proj', now })

  it('lists Claude subagent transcripts with seat, model and status', async () => {
    const fs = memFs({
      [`${dir}/subagents/agent-a1.jsonl`]: jl({ type: 'user', message: { role: 'user', content: 'go' } }, { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use' } }),
      [`${dir}/subagents/agent-a1.meta.json`]: JSON.stringify({ agentType: 'reviewer' }),
      [`${dir}/subagents/agent-b2.jsonl`]: jl({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn' } }, { type: 'attachment' }, { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: null } }),
    })
    const agents = await reader(fs).sync(runId, src)
    expect(agents.map((a) => [a.seat, a.model, a.status])).toEqual([
      ['reviewer', 'claude-haiku-4-5', 'working'],
      ['agent-b2', 'claude-sonnet-5-5', 'done'],
    ])
    expect(agents[0]!.transcriptRef).toBe('claude:sess1:agent-a1')
  })

  it('updates on later passes without duplicating, and closes everything on final', async () => {
    const files: Record<string, string> = { [`${dir}/subagents/agent-a1.jsonl`]: jl({ type: 'user', message: {} }) }
    const r = reader(memFs(files))
    await r.sync(runId, src)
    files[`${dir}/subagents/agent-a1.jsonl`] = jl({ type: 'assistant', message: { model: 'claude-opus-4-7', stop_reason: 'tool_use' } })
    const again = await reader(memFs(files)).sync(runId, src)
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ model: 'claude-opus-4-7', status: 'working' })
    const final = await reader(memFs(files)).sync(runId, src, true)
    expect(final[0]!.status).toBe('done')
  })

  it('treats a quiet transcript as done', async () => {
    const fs = memFs({ [`${dir}/subagents/agent-a1.jsonl`]: jl({ type: 'user' }) }, 0)
    const agents = await reader(fs, () => 120_000).sync(runId, src)
    expect(agents[0]!.status).toBe('done')
  })

  it('reads sidechain turns from the main transcript on older layouts', async () => {
    const fs = memFs({
      [`${dir}.jsonl`]: jl({ type: 'assistant', message: { model: 'm0' } }, { type: 'assistant', isSidechain: true, agentId: 'x9', message: { model: 'claude-haiku-4-5' } }),
    })
    const agents = await reader(fs).sync(runId, src)
    expect(agents.map((a) => [a.seat, a.model])).toEqual([['x9', 'claude-haiku-4-5']])
  })

  it('tolerates unknown shapes, bad lines and missing folders', async () => {
    const fs = memFs({ [`${dir}/subagents/agent-z.jsonl`]: 'not json\n[1,2]\n{"type":42,"message":"str"}\n' })
    const agents = await reader(fs).sync(runId, src)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ seat: 'agent-z', model: '', status: 'working' })
    expect(await reader(memFs({})).sync(runId, { ...src, sessionId: 'none' })).toHaveLength(1)
  })

  it('reads OpenCode child sessions and closes them at the end', async () => {
    const oc = new SubagentReader({ store, children: async () => [{ id: 'c1', title: 'Explore repo', agent: 'explore', directory: '/x', model: 'p/m', done: false }, { id: '', title: '', agent: '', directory: '', model: '', done: false }] })
    const s = { cli: 'opencode' as const, cwd: '/code/shop', sessionId: 'ses_1' }
    expect((await oc.sync(runId, s))[0]).toMatchObject({ seat: 'explore', model: 'p/m', status: 'working', transcriptRef: 'opencode:c1' })
    expect((await oc.sync(runId, s, true))[0]!.status).toBe('done')
    expect(store.listJobAgents(runId)).toHaveLength(1)
  })

  it('never throws when OpenCode is down', async () => {
    const oc = new SubagentReader({ store, children: async () => { throw new Error('down') } })
    expect(await oc.sync(runId, { cli: 'opencode', cwd: '/c', sessionId: 's' })).toEqual([])
  })

  it('returns the tail of an agent transcript as scrubbed plain lines, tolerating odd shapes', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `line ${i}` }] } }))
    const fs = memFs({
      [`${dir}/subagents/agent-a1.jsonl`]: jl(
        { type: 'user', message: { role: 'user', content: 'use key sk-abcdefghijklmnopqrstuv1234' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }, { type: 'thinking', thinking: 'hidden' }] } },
        { weird: [1, 2, { nested: true }] },
        ...big,
      ) + '\n{not json',
    })
    await reader(fs).sync(runId, src)
    const agent = store.listJobAgents(runId)[0]!
    const lines = await reader(fs).log(agent.id, '/code/shop')
    expect(lines).toHaveLength(200)
    expect(lines.at(-1)).toBe('assistant: line 299')

    const small = memFs({
      [`${dir}/subagents/agent-a1.jsonl`]: jl({ type: 'user', message: { role: 'user', content: 'use key sk-abcdefghijklmnopqrstuv1234' } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }] } }, { weird: 1 }),
    })
    expect(await reader(small).log(agent.id, '/code/shop')).toEqual(['user: use key [secret]', 'tool: Read {"path":"/x"}'])
    expect(await reader(memFs({})).log(agent.id, '/code/shop')).toEqual([])
    expect(await reader(small).log(99999, '/code/shop')).toEqual([])
  })

  it('reads an OpenCode child session through the messages call', async () => {
    store.addJobAgent(runId, { seat: 'build', transcriptRef: 'opencode:ses_child' })
    const agent = store.listJobAgents(runId)[0]!
    const r = new SubagentReader({ store, messages: async (id) => (id === 'ses_child' ? [{ type: 'user', text: 'list files' }, { type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/x' } } }, { type: 'text', text: 'Bearer abcdefghijklmnopqrstuvwx done' }] }, { type: 'idle', outcome: 'succeeded' }, 'odd', null] : []) })
    expect(await r.log(agent.id, '/code/shop')).toEqual(['user: list files', 'tool: read {"path":"/x"}', 'assistant: Bearer [secret] done'])
  })
})
