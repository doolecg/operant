import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HindsightService, bankFor, projectKey, setSharedBanks, type HindsightDeps } from './hindsight'

const resp = (ok: boolean, body: unknown = {}, status = ok ? 200 : 500) => ({ ok, status, json: async () => body })

function svc(over: Partial<HindsightDeps>, opts = {}) {
  return new HindsightService({ settingsFile: 'x', ...opts }, { readJson: () => null, sleep: async () => {}, ...over })
}

describe('hindsight service', () => {
  it('names one bank per project folder', () => {
    expect(bankFor(String.raw`C:\code\Shop`)).toBe(bankFor('c:/code/shop/'))
    expect(bankFor('/a/shop')).not.toBe(bankFor('/b/shop'))
    expect(bankFor('/a/My Shop')).toMatch(/^operant-my-shop-[a-z0-9]+$/)
  })

  it('reports a missing uvx as a clear status when the server is down', async () => {
    const s = svc({ fetch: async () => { throw new Error('refused') }, run: async () => ({ code: null, stdout: '', stderr: 'ENOENT' }) })
    const st = await s.status()
    expect(st.state).toBe('no-uv')
    expect(st.detail).toMatch(/uv isn't installed/)
    expect((await s.act('start')).state).toBe('no-uv')
  })

  it('reports running, stopped and a remote server', async () => {
    expect((await svc({ fetch: async () => resp(true) }).status()).state).toBe('running')
    const down = svc({ fetch: async () => { throw new Error('x') }, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect((await down.status()).state).toBe('stopped')
    const remote = svc({ fetch: async () => { throw new Error('x') } }, { url: () => 'http://nas:9077/' })
    expect(await remote.status()).toMatchObject({ state: 'error', managed: false, url: 'http://nas:9077' })
    expect((await remote.act('start')).detail).toMatch(/Hosted elsewhere/)
  })

  it('starts the daemon through uvx on the coding-agent profile and waits for health', async () => {
    const calls: string[][] = []
    let up = false
    const s = svc(
      {
        fetch: async () => resp(up),
        run: async (_c, args) => {
          calls.push(args)
          if (args[1] === 'daemon') up = true
          return { code: 0, stdout: '', stderr: '' }
        },
      },
      { llmEnv: () => ({ HINDSIGHT_API_LLM_PROVIDER: 'claude-code' }) },
    )
    expect((await s.act('start')).state).toBe('running')
    expect(calls[1]).toEqual(['hindsight-embed@latest', 'daemon', '--profile', 'coding-agent', 'start'])
  })

  it('never throws from recall or retain', async () => {
    const s = svc({ fetch: async () => { throw new Error('down') } })
    expect(await s.recall('b', 'q')).toEqual({ ok: false, error: 'unreachable at http://127.0.0.1:9077' })
    expect(await s.retain('b', 'c', [])).toEqual({ ok: false, error: 'unreachable at http://127.0.0.1:9077' })
  })

  describe('adopting the agent plugins server', () => {
    const file = { serverMode: 'self-hosted', apiUrl: 'http://10.0.0.5:8888/' }
    it('uses apiUrl from coding-agent.json when Operant has no URL and is local', async () => {
      const seen: string[] = []
      const s = svc({ readJson: () => file, fetch: async (u) => (seen.push(u), resp(true)) })
      expect(s.url).toBe('http://10.0.0.5:8888')
      expect(s.managed).toBe(false)
      expect(s.mode).toBe('remote')
      expect((await s.status()).detail).toContain('adopted')
      await s.recall('b', 'q')
      expect(seen.at(-1)).toMatch(/^http:\/\/10.0.0.5:8888\/v1\/default\/banks\/b\/memories\/recall$/)
    })
    it('does not adopt when Operant has its own URL, shares a daemon, or the file is not self-hosted with an apiUrl', () => {
      expect(svc({ readJson: () => file }, { url: () => 'http://nas:1' }).url).toBe('http://nas:1')
      expect(svc({ readJson: () => file }, { lan: () => ({ host: '0.0.0.0', port: 9077, openBind: true }) }).mode).toBe('lan')
      expect(svc({ readJson: () => ({ ...file, serverMode: 'embedded' }) }).managed).toBe(true)
      expect(svc({ readJson: () => ({ serverMode: 'self-hosted' }) }).url).toBe('http://127.0.0.1:9077')
      expect(svc({ readJson: () => ({ ...file, apiUrl: 'file:///x' }) }).managed).toBe(true)
    })
  })

  it('reads recall results of different shapes and posts retain with tags', async () => {
    const seen: Array<{ url: string; body: any }> = []
    const s = svc({
      fetch: async (url, init) => {
        seen.push({ url, body: JSON.parse(String(init?.body)) })
        return resp(true, url.endsWith('/recall') ? { results: [{ text: 'a' }, { content: 'b' }, 'c', {}] } : {})
      },
    })
    expect(await s.recall('bank 1', 'q')).toEqual({ ok: true, items: ['a', 'b', 'c'] })
    await s.retain('bank 1', 'text', ['file:x'])
    expect(seen[0]!.url).toContain('/v1/default/banks/bank%201/memories/recall')
    expect(seen[1]!.body.items[0]).toMatchObject({ content: 'text', tags: ['file:x'] })
  })

  describe('hosting modes and the API key', () => {
    const KEY = 'sekrit-key-123456'
    const lan = (host = '0.0.0.0', openBind = false) => ({ lan: () => ({ host, port: 9100, openBind }) })
    const ran = { code: 0, stdout: '', stderr: '' }

    it('sends Authorization: Bearer on health, recall and retain when a key is set, and not otherwise', async () => {
      const seen: Array<Record<string, string>> = []
      const fetch = async (_u: string, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>)
        return resp(true, { results: [] })
      }
      const withKey = svc({ fetch }, { key: () => KEY, url: () => 'http://nas:9077' })
      await withKey.status()
      await withKey.recall('b', 'q')
      await withKey.retain('b', 'c', [])
      expect(seen).toHaveLength(3)
      for (const h of seen) expect(h.authorization).toBe(`Bearer ${KEY}`)
      seen.length = 0
      await svc({ fetch }).recall('b', 'q')
      expect(seen[0]!.authorization).toBeUndefined()
    })

    it('probes 127.0.0.1 for a shared server, then the bound adapter when loopback is not served', async () => {
      const urls: string[] = []
      const s = svc({ fetch: async (u) => { urls.push(u); return resp(u.startsWith('http://192.168.1.5')) } }, { ...lan('192.168.1.5') })
      expect((await s.status()).state).toBe('running')
      expect(urls).toEqual(['http://127.0.0.1:9100/health', 'http://192.168.1.5:9100/health'])
      expect(s.url).toBe('http://192.168.1.5:9100')
      const all: string[] = []
      await svc({ fetch: async (u) => { all.push(u); return resp(false) }, run: async () => ran }, lan('0.0.0.0')).status()
      expect(all).toEqual(['http://127.0.0.1:9100/health'])
    })

    it('reports the mode and starts a shared daemon with host, port and the key requirement in its environment', async () => {
      let env: NodeJS.ProcessEnv = {}
      let up = false
      const s = svc(
        { fetch: async () => resp(up), run: async (_c, args, o) => { if (args[1] === 'daemon') { up = true; env = o.env ?? {} } return ran } },
        { ...lan('100.101.102.103'), key: () => KEY },
      )
      expect(s.mode).toBe('lan')
      const st = await s.act('start')
      expect(st).toMatchObject({ state: 'running', mode: 'lan' })
      expect(st.pendingRestart).toBeUndefined()
      expect(env).toMatchObject({
        HINDSIGHT_API_HOST: '100.101.102.103',
        HINDSIGHT_API_PORT: '9100',
        HINDSIGHT_API_TENANT_EXTENSION: 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
        HINDSIGHT_API_TENANT_API_KEY: KEY,
      })
    })

    it('local mode sets no host or key on the daemon', async () => {
      let env: NodeJS.ProcessEnv = {}
      let up = false
      const s = svc({ fetch: async () => resp(up), run: async (_c, a, o) => { if (a[1] === 'daemon') { up = true; env = o.env ?? {} } return ran } })
      expect(s.mode).toBe('local')
      await s.act('start')
      expect(env.HINDSIGHT_API_HOST).toBeUndefined()
      expect(env.HINDSIGHT_API_TENANT_API_KEY).toBeUndefined()
    })

    it('refuses a keyless non-loopback bind unless it was confirmed, and says a restart is needed after a change', async () => {
      const calls: string[][] = []
      const run = async (_c: string, args: string[]) => { calls.push(args); return ran }
      const refused = await svc({ fetch: async () => resp(false), run }, lan('0.0.0.0')).act('start')
      expect(refused).toMatchObject({ state: 'error' })
      expect(refused.detail).toMatch(/needs an API key/)
      expect(calls).toEqual([])
      let up = false
      let host = '0.0.0.0'
      const s = svc({ fetch: async () => resp(up), run: async (_c, a) => { if (a[1] === 'daemon') up = true; return ran } }, {
        lan: () => ({ host, port: 9100, openBind: true }),
      })
      expect((await s.act('start')).pendingRestart).toBeUndefined()
      host = '127.0.0.1'
      expect((await s.status()).pendingRestart).toBe(true)
      const fresh = svc({ fetch: async () => resp(true) }, lan('0.0.0.0', true))
      expect((await fresh.status()).pendingRestart).toBe(true)
    })

    it('restart stops then starts', async () => {
      const calls: string[] = []
      let up = true
      const s = svc({ fetch: async () => resp(up), run: async (_c, a) => { if (a[1] === 'daemon') { calls.push(a[4]!); up = a[4] === 'start' } return ran } }, { ...lan('127.0.0.1') })
      expect((await s.act('restart')).state).toBe('running')
      expect(calls).toEqual(['stop', 'start'])
    })

    it('stops a shared daemon by ending the process listening on its port, since the embed CLI only sees 127.0.0.1', async () => {
      let up = true
      const killed: number[] = []
      const netstat = [
        '  TCP    127.0.0.1:9077         0.0.0.0:0              LISTENING       111',
        '  TCP    127.0.0.2:9100         0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:50000        127.0.0.2:9100         TIME_WAIT       0',
      ].join('\r\n')
      const s = svc(
        {
          fetch: async () => resp(up),
          kill: (pid) => { killed.push(pid); up = false },
          run: async (c) => {
            if (c === 'netstat' || c === 'lsof') return { code: 0, stdout: c === 'netstat' ? netstat : '4242\n', stderr: '' }
            return ran
          },
        },
        { lan: () => ({ host: '127.0.0.2', port: 9100, openBind: true }) },
      )
      expect((await s.act('stop')).state).toBe('stopped')
      expect(killed).toEqual([4242])
    })

    it('remote never starts or stops, and shows as remote', async () => {
      const calls: string[][] = []
      const s = svc({ fetch: async () => resp(true), run: async (_c, a) => { calls.push(a); return ran } }, { url: () => 'http://nas:9077' })
      expect(s.mode).toBe('remote')
      expect((await s.act('start')).detail).toMatch(/Hosted elsewhere/)
      expect((await s.act('restart')).mode).toBe('remote')
      expect(calls).toEqual([])
    })

    it('never puts the key in an error, a status or a test result', async () => {
      const boom = svc({ fetch: async () => { throw new Error(`connect failed for Bearer ${KEY}`) } }, { key: () => KEY, url: () => 'http://nas:9077' })
      expect(JSON.stringify(await boom.test())).not.toContain(KEY)
      const r = await svc({ fetch: async () => resp(false), run: async (_c, a) => (a[0] === '--version' ? ran : { code: 1, stdout: '', stderr: `bad ${KEY}` }) }, { ...lan('127.0.0.1'), key: () => KEY }).act('start')
      expect(r.state).toBe('error')
      expect(JSON.stringify(r)).not.toContain(KEY)
    })

    it('test connection: ok with bank count and latency, denied, unreachable, wrong status', async () => {
      let t = 0
      const now = () => (t += 7)
      const ok = svc({ now, fetch: async (u, init) => (u.endsWith('/banks') && !(init?.headers as Record<string, string> | undefined)?.authorization ? resp(false, {}, 401) : resp(true, u.endsWith('/banks') ? { banks: [{}, {}] } : {})) }, { url: () => 'http://nas:9077', key: () => KEY })
      expect(await ok.test()).toMatchObject({ ok: true, reachable: true, auth: 'ok', info: '2 banks', latencyMs: 7, open: false })
      const open = svc({ fetch: async () => resp(true, { banks: [] }) }, { url: () => 'http://nas:9077', key: () => KEY })
      expect((await open.test()).open).toBe(true)
      const denied = svc({ fetch: async (u) => (u.endsWith('/banks') ? resp(false, {}, 401) : resp(true)) }, { url: () => 'http://nas:9077' })
      expect(await denied.test()).toMatchObject({ ok: false, reachable: true, auth: 'denied', error: 'The server needs an API key and none is saved' })
      const wrongKey = svc({ fetch: async (u) => (u.endsWith('/banks') ? resp(false, {}, 403) : resp(true)) }, { url: () => 'http://nas:9077', key: () => KEY })
      expect((await wrongKey.test()).error).toBe('The server refused the API key')
      const down = svc({ fetch: async () => { throw new Error('ECONNREFUSED') } }, { url: () => 'http://nas:9077' })
      expect(await down.test()).toMatchObject({ ok: false, reachable: false, auth: 'unknown', error: 'ECONNREFUSED', latencyMs: null })
      const odd = svc({ fetch: async (u) => (u.endsWith('/banks') ? resp(false, {}, 500) : resp(true)) }, { url: () => 'http://nas:9077' })
      expect(await odd.test()).toMatchObject({ ok: false, reachable: true, error: 'Banks list answered 500' })
    })
  })

  describe('bank names on a shared server', () => {
    afterEach(() => setSharedBanks(false))

    it('keep the local names as they were, and differ per project once shared', () => {
      const local = bankFor('/code/shop')
      setSharedBanks(true)
      const shared = bankFor('/code/shop')
      expect(shared).toMatch(/^operant-shop-[a-z0-9]+$/)
      expect(shared).not.toBe(local)
      expect(bankFor('/code/shop/')).toBe(shared)
      expect(bankFor('/code/other')).not.toBe(shared)
    })

    it('use the git origin so clones of one repo agree wherever they sit, and repos sharing a folder name do not', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bank-'))
      const mk = (name: string, url: string) => {
        mkdirSync(join(dir, name, '.git'), { recursive: true })
        writeFileSync(join(dir, name, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
        return join(dir, name)
      }
      try {
        const a = mk('shop', 'https://github.com/me/shop.git')
        const ssh = mk('shop-ssh', 'git@github.com:me/shop.git')
        expect(projectKey(a)).toBe('github.com/me/shop')
        expect(projectKey(ssh)).toBe('github.com/me/shop')
        const other = mk('shop3', 'https://github.com/you/shop.git')
        setSharedBanks(true)
        expect(bankFor(other)).not.toBe(bankFor(a))
        expect(projectKey(join(dir, 'nothing'))).toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
