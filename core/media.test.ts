import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaState } from '../shared/media'
import { helperArgs, MediaService } from './media'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, '..', 'e2e', 'fixtures', 'fake-media-helper.mjs')
const dir = mkdtempSync(join(tmpdir(), 'operant-media-'))
const logFile = join(dir, 'commands.log')
afterEach(() => {
  rmSync(logFile, { force: true })
})

const launch = () =>
  spawn(process.execPath, [fake], { env: { ...process.env, OPERANT_FAKE_MEDIA_LOG: logFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

async function until(cond: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return
  throw new Error('timed out')
}

type Inner = { proc: { pid: number; kill(): void } | null }

describe('MediaService', () => {
  it('merges state, art and timeline lines and pushes each as its own event', async () => {
    const svc = new MediaService({ script: 'x', platform: 'win32', launch })
    const events: string[] = []
    svc.on('media:state', () => events.push('state'))
    svc.on('media:art', () => events.push('art'))
    svc.on('media:timeline', () => events.push('timeline'))
    svc.start()
    await until(() => !!svc.state.timeline)
    expect(events).toEqual(['state', 'art', 'timeline'])
    expect(svc.state).toMatchObject({ active: true, title: expect.stringContaining('Midnight City'), artist: 'M83', playing: true, volume: 0.4 })
    expect(svc.state.art).toMatch(/^data:image\/png;base64,/)
    expect(svc.state.timeline).toMatchObject({ pos: 62, dur: 244 })
    svc.stop()
    await until(() => !svc.running)
  })

  it('sends only whitelisted commands to the helper', async () => {
    const svc = new MediaService({ script: 'x', platform: 'win32', launch })
    svc.start()
    await until(() => svc.state.active)
    const sent = ['toggle', 'next', 'prev', 'shuffle', 'focus', 'vol 0.5', 'vol 0', 'vol 1'].map((c) => svc.command(c))
    expect(sent.every(Boolean)).toBe(true)
    const refused = ['quit', 'vol 2', 'vol -1', 'toggle\nnext', 'vol 0.5; calc', '', 'TOGGLE', 7].map((c) => svc.command(c))
    expect(refused.some(Boolean)).toBe(false)
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').trim().split('\n').length >= 8)
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toEqual(['toggle', 'next', 'prev', 'shuffle', 'focus', 'vol 0.5', 'vol 0', 'vol 1'])
    await until(() => svc.state.playing === false)
    svc.stop()
    await until(() => !svc.running)
  })

  it('restarts the helper after it dies, and not after stop()', async () => {
    const svc = new MediaService({ script: 'x', platform: 'win32', restartMs: 50, launch })
    const states: MediaState[] = []
    svc.on('media:state', (s) => states.push(s))
    svc.start()
    await until(() => !!svc.state.timeline)
    const first = (svc as unknown as Inner).proc!
    first.kill()
    await until(() => states.some((s) => !s.active))
    await until(() => svc.state.active && (svc as unknown as Inner).proc?.pid !== first.pid)
    svc.stop()
    await until(() => !svc.running)
    const n = states.length
    await new Promise((r) => setTimeout(r, 200))
    expect(states.length).toBe(n)
    expect(svc.running).toBe(false)
  })

  it('does nothing off Windows', () => {
    const launcher = vi.fn(launch)
    const svc = new MediaService({ script: 'x', platform: 'linux', launch: launcher })
    svc.start()
    expect(launcher).not.toHaveBeenCalled()
    expect(svc.running).toBe(false)
    expect(svc.command('toggle')).toBe(false)
    expect(svc.state).toEqual({ active: false })
  })

  it('launches PowerShell hidden, with no profile and no logo, only through the shared hidden-spawn helper', () => {
    const args = helperArgs('C:\\app\\helper\\media-helper.ps1')
    expect(args.slice(0, 3)).toEqual(['-WindowStyle', 'Hidden', '-NoProfile'])
    expect(args).toContain('-NoLogo')
    expect(args.slice(-2)).toEqual(['-File', 'C:\\app\\helper\\media-helper.ps1'])
    const src = readFileSync(join(here, 'media.ts'), 'utf8')
    expect(src).toMatch(/spawnHidden\('powershell\.exe', helperArgs\(script\)/)
    expect(src).not.toMatch(/\bspawn\(/)
  })
})
