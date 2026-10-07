import { EventEmitter } from 'node:events'
import { isMediaCommand, type MediaState, type MediaTimeline } from '../shared/media'
import { spawnHidden } from './proc'

type ChildProcess = ReturnType<typeof spawnHidden>

// Runs helper/media-helper.ps1 (Windows media session and Core Audio) through the shared hidden-spawn helper and
// relays what it reports. The helper prints a JSON line per state change, { timeline } and { art } lines for the
// track position and cover; commands go back one per line. Windows only: elsewhere every call is a no-op.

// Never a visible console: -WindowStyle Hidden on top of windowsHide. Bypass applies only to our own bundled script.
export const helperArgs = (script: string): string[] => [
  '-WindowStyle', 'Hidden', '-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
]

export interface MediaEvents {
  'media:state': [MediaState]
  'media:timeline': [MediaTimeline | null]
  'media:art': [string | null]
}

export interface MediaOptions {
  script: string
  platform?: NodeJS.Platform
  restartMs?: number
  // Test hook: starts the helper process.
  launch?: (script: string) => ChildProcess
}

const defaultLaunch = (script: string): ChildProcess =>
  spawnHidden('powershell.exe', helperArgs(script), { source: 'media', stdio: ['pipe', 'pipe', 'pipe'] })

export class MediaService extends EventEmitter<MediaEvents> {
  private proc: ChildProcess | null = null
  private wanted = false
  private restartTimer: NodeJS.Timeout | null = null
  private last: MediaState = { active: false }
  private readonly platform: NodeJS.Platform
  private readonly restartMs: number

  constructor(private readonly opts: MediaOptions) {
    super()
    this.platform = opts.platform ?? process.platform
    this.restartMs = opts.restartMs ?? 5000
  }

  get state(): MediaState {
    return this.last
  }

  get running(): boolean {
    return this.proc !== null
  }

  start(): void {
    if (this.platform !== 'win32') return
    this.wanted = true
    if (this.proc) return
    let proc: ChildProcess
    try {
      proc = (this.opts.launch ?? defaultLaunch)(this.opts.script)
    } catch {
      this.scheduleRestart()
      return
    }
    this.proc = proc
    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.handleLine(line)
      }
    })
    // stdout/stderr are also logged to the in-app console by spawnHidden.
    proc.on('error', () => undefined)
    proc.on('close', () => {
      if (this.proc !== proc) return
      this.proc = null
      this.last = { active: false }
      this.emit('media:state', this.last)
      this.scheduleRestart()
    })
  }

  stop(): void {
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin?.end()
    } catch {
      /* already closed */
    }
    // The helper exits when stdin closes; kill it if it does not.
    const t = setTimeout(() => proc.kill(), 1500)
    t.unref()
    proc.once('close', () => clearTimeout(t))
  }

  // Only the whitelisted commands reach the helper; returns whether it was sent.
  command(cmd: unknown): boolean {
    if (!this.proc || !isMediaCommand(cmd)) return false
    this.proc.stdin?.write(cmd + '\n')
    return true
  }

  private scheduleRestart(): void {
    if (!this.wanted) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, this.restartMs)
  }

  private handleLine(line: string): void {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    // The position and cover come as their own small lines so the state is not resent with the image every time.
    if (o.timeline !== undefined) {
      this.last = { ...this.last, timeline: o.timeline as MediaTimeline | null }
      this.emit('media:timeline', this.last.timeline ?? null)
    } else if (o.art !== undefined) {
      this.last = { ...this.last, art: o.art as string | null }
      this.emit('media:art', this.last.art ?? null)
    } else {
      const s = o as unknown as MediaState
      this.last = { ...s, art: s.active ? this.last.art : null, timeline: s.active ? this.last.timeline : null }
      this.emit('media:state', this.last)
    }
  }
}
