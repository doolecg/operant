import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), getPath: () => '.' },
  shell: {},
}))

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { BrowserPrompts } from './browser-prompts'

type RequestHandler = (wc: unknown, permission: string, cb: (ok: boolean) => void, details: Record<string, unknown>) => void
type CheckHandler = (wc: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean

function setup() {
  const prompts = new BrowserPrompts()
  let request!: RequestHandler
  let check!: CheckHandler
  const ses = {
    setPermissionRequestHandler: (h: RequestHandler) => (request = h),
    setPermissionCheckHandler: (h: CheckHandler) => (check = h),
    on: vi.fn(),
  }
  prompts.attachSession(1, ses as never)
  // A tab the prompts layer knows, without the debugger plumbing.
  const wc = { id: 7, getURL: () => 'https://a.test/page' }
  ;(prompts as unknown as { tabs: Map<number, unknown> }).tabs.set(7, { crewId: 1, tabId: 3, wc })
  const ask = (permission: string, url = 'https://a.test/page') => {
    const cb = vi.fn()
    request(wc, permission, cb, { requestingUrl: url })
    return cb
  }
  return { prompts, ask, check: (p: string, origin = 'https://a.test') => check(wc, p, origin, {}) }
}

describe('BrowserPrompts AI grants', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks the user before a grant, then answers a granted origin and permission without asking', () => {
    const { prompts, ask, check } = setup()
    const first = ask('geolocation')
    expect(first).not.toHaveBeenCalled()
    expect(prompts.state(1).prompts).toHaveLength(1)
    expect(check('geolocation')).toBe(false)

    prompts.grantPermissions(1, 'https://a.test', ['geolocation'])
    const second = ask('geolocation')
    expect(second).toHaveBeenCalledWith(true)
    expect(check('geolocation')).toBe(true)
    // Other origin and other permission are untouched.
    expect(check('geolocation', 'https://b.test')).toBe(false)
    expect(check('notifications')).toBe(false)
    expect(ask('geolocation', 'https://b.test')).not.toHaveBeenCalled()
  })

  it('never grants camera/microphone or permissions the layer always refuses', () => {
    const { prompts, ask, check } = setup()
    prompts.grantPermissions(1, 'https://a.test', ['media', 'payment-handler', 'openExternal', 'clipboard-write'])
    expect(ask('payment-handler')).toHaveBeenCalledWith(false)
    expect(ask('openExternal')).toHaveBeenCalledWith(false)
    expect(check('payment-handler')).toBe(false)
    expect(ask('media')).not.toHaveBeenCalled()
    expect(check('media')).toBe(false)
  })

  it('resetGrants and forgetCrew remove the grants', () => {
    const { prompts, check } = setup()
    prompts.grantPermissions(1, 'https://a.test', ['notifications'])
    expect(check('notifications')).toBe(true)
    prompts.resetGrants(1)
    expect(check('notifications')).toBe(false)
    prompts.grantPermissions(1, 'https://a.test', ['notifications'])
    prompts.forgetCrew(1)
    expect(check('notifications')).toBe(false)
  })
})

describe('BrowserPrompts download records for the AI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operant-dl-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // A DownloadItem that saves `body` to the path it was given when finished.
  function start(prompts: BrowserPrompts, crewId: number, name: string, body: Buffer, mime = 'text/plain') {
    let handler!: (e: unknown, item: unknown) => void
    prompts.attachSession(crewId, { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: (_n: string, h: typeof handler) => (handler = h) } as never)
    const item = Object.assign(new EventEmitter(), {
      path: '',
      getFilename: () => name,
      getURL: () => `https://files.test/${name}?token=secret`,
      getMimeType: () => mime,
      getTotalBytes: () => body.length,
      getReceivedBytes: () => body.length,
      setSavePath(p: string) {
        this.path = p
      },
      cancel: vi.fn(),
    })
    handler({}, item)
    return {
      finish: (state: 'completed' | 'cancelled' | 'interrupted') => {
        if (state === 'completed') writeFileSync(item.path, body)
        item.emit('done', {}, state)
      },
    }
  }

  it('lists a download with its metadata and reads it back only once completed, from its saved path', async () => {
    const prompts = new BrowserPrompts({ downloadsDir: () => dir })
    const a = start(prompts, 1, 'note.txt', Buffer.from('hello'))
    expect(prompts.listDownloads(1)).toMatchObject([{ filename: 'note.txt', state: 'progressing', mime: 'text/plain' }])
    const id = prompts.listDownloads(1)[0]!.id
    expect(await prompts.readDownload(1, id, 100)).toBeNull()
    a.finish('completed')
    const c = await prompts.readDownload(1, id, 100)
    expect(Buffer.from(c!.head).toString()).toBe('hello')
    expect(c!.size).toBe(5)
    expect(c!.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(prompts.listDownloads(1)[0]).toMatchObject({ state: 'completed', size: 5 })
    // Capped read.
    expect(Buffer.from((await prompts.readDownload(1, id, 2))!.head).toString()).toBe('he')
  })

  it('a cancelled download is listed as cancelled and cannot be read; other projects and unknown ids see nothing', async () => {
    const prompts = new BrowserPrompts({ downloadsDir: () => dir })
    start(prompts, 1, 'gone.txt', Buffer.from('x')).finish('cancelled')
    const done = start(prompts, 2, 'other.txt', Buffer.from('y'))
    done.finish('completed')
    const gone = prompts.listDownloads(1).find((d) => d.filename === 'gone.txt')!
    expect(gone.state).toBe('cancelled')
    expect(await prompts.readDownload(1, gone.id, 10)).toBeNull()
    const other = prompts.listDownloads(2)[0]!
    expect(await prompts.readDownload(1, other.id, 10)).toBeNull()
    expect(await prompts.readDownload(2, other.id, 10)).not.toBeNull()
    expect(await prompts.readDownload(1, '../../etc/passwd', 10)).toBeNull()
    prompts.forgetCrew(2)
    expect(prompts.listDownloads(2)).toEqual([])
  })

  it('keeps at most 100 records per project, newest first', () => {
    const prompts = new BrowserPrompts({ downloadsDir: () => dir })
    for (let i = 0; i < 105; i++) start(prompts, 3, `f${String(i)}.txt`, Buffer.from('z'))
    const list = prompts.listDownloads(3)
    expect(list).toHaveLength(100)
    expect(list[0]!.filename).toBe('f104.txt')
  })
})
