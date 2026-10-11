import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The exit codes `operant` reports (cli/operant.ts maps them to its own output).
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  FORBIDDEN: 5,
  LIMITED: 6,
  UNREACHABLE: 7,
} as const

// Who a request runs for: the project of the tile whose token sent it.
export interface Identity {
  crewId: number
}

export interface CliRequest {
  cmd: string
  args?: Record<string, unknown>
}

export interface CliResult {
  exit: number
  out?: string
  error?: string
}

export const MAX_REQUEST_BYTES = 64 * 1024
const TOKEN_BYTES = 32
// macOS limits a Unix socket path to 104 bytes including the terminator.
const MAX_SOCKET_PATH = 103

export interface CliTarget {
  identify(tileId: number): Identity | null
  run(who: Identity, req: CliRequest, signal?: AbortSignal): Promise<CliResult>
}

export interface CliServerOptions {
  target: CliTarget
  // Parent of the per-user socket directory on POSIX (default the OS temp dir).
  dir?: string
  maxRequestBytes?: number
  // How long a connection may take to send its whole request line.
  requestTimeoutMs?: number
  maxConnections?: number
  // Server errors after listen; never given tokens or the socket path by this class.
  onError?: (err: unknown) => void
}

const FORBIDDEN: CliResult = { exit: EXIT.FORBIDDEN, error: 'forbidden' }

// A directory only this user can enter, refusing a symlink or someone else's directory.
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  const uid = process.getuid?.()
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    throw new Error('The Operant socket directory is not a private directory')
  }
  chmodSync(dir, 0o700)
}

export function socketPath(base = tmpdir()): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\operant2-${randomBytes(16).toString('hex')}`
  const uid = process.getuid?.() ?? 0
  const name = `${randomBytes(8).toString('hex')}.sock`
  let dir = join(base, `operant2-${uid}`)
  if (Buffer.byteLength(join(dir, name)) > MAX_SOCKET_PATH) dir = join('/tmp', `operant2-${uid}`)
  privateDir(dir)
  return join(dir, name)
}

// The agent-facing transport: a local socket (named pipe on Windows), one JSON line in, one JSON line
// out, then close. The caller's identity comes only from its session token. Tokens and the socket path
// are never logged.
export class CliServer {
  private readonly target: CliTarget
  private readonly maxBytes: number
  private readonly timeoutMs: number
  private readonly base: string | undefined
  private readonly maxConnections: number
  private readonly onError: (err: unknown) => void
  private readonly tokens = new Map<number, Buffer>()
  private readonly active = new Map<number, Set<Socket>>()
  private readonly sockets = new Set<Socket>()
  private readonly revokeListeners = new Set<(tileId: number) => void>()
  private server: Server | null = null
  private path = ''

  constructor(opts: CliServerOptions) {
    this.target = opts.target
    this.maxBytes = opts.maxRequestBytes ?? MAX_REQUEST_BYTES
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000
    this.base = opts.dir
    this.maxConnections = opts.maxConnections ?? 256
    this.onError = opts.onError ?? (() => {})
  }

  // The value for OPERANT_SOCKET.
  get address(): string {
    return this.path
  }

  async listen(): Promise<string> {
    if (this.server) return this.path
    const path = socketPath(this.base)
    const server = createServer((socket) => this.handle(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    server.maxConnections = this.maxConnections
    server.on('error', (err) => this.onError(err))
    this.server = server
    this.path = path
    return path
  }

  // A fresh 32-byte token for the tile's session (hex, for OPERANT_TOKEN); replaces any earlier one.
  issueToken(tileId: number): string {
    this.revokeToken(tileId)
    const token = randomBytes(TOKEN_BYTES)
    this.tokens.set(tileId, token)
    return token.toString('hex')
  }

  // Refuses the tile's token from now on and drops its open connections (a waiting inbox included).
  revokeToken(tileId: number): void {
    const had = this.tokens.delete(tileId)
    for (const s of this.active.get(tileId) ?? []) s.destroy()
    this.active.delete(tileId)
    if (had) this.notifyRevoked(tileId)
  }

  // The tile a token belongs to, or null (unknown or revoked). Timing-safe, like every other check.
  whoIs(token: unknown): number | null {
    return this.authenticate(token)
  }

  // Called whenever a tile's token stops being valid (revoked, replaced or the server closing).
  onRevoke(cb: (tileId: number) => void): () => void {
    this.revokeListeners.add(cb)
    return () => this.revokeListeners.delete(cb)
  }

  private notifyRevoked(tileId: number): void {
    for (const cb of this.revokeListeners) {
      try {
        cb(tileId)
      } catch {
        // A listener must not break revocation.
      }
    }
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    const ids = [...this.tokens.keys()]
    this.tokens.clear()
    for (const id of ids) this.notifyRevoked(id)
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.path)
      } catch {
        // Already gone.
      }
    }
  }

  // Every issued token is compared, whatever matches, so timing says nothing about which one did.
  private authenticate(token: unknown): number | null {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null
    const given = Buffer.from(token, 'hex')
    let found: number | null = null
    for (const [tileId, t] of this.tokens) {
      if (timingSafeEqual(given, t) && found === null) found = tileId
    }
    return found
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket)
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const controller = new AbortController()
    // One deadline for the whole request line (an idle timeout would let a slow sender stay forever).
    const deadline = setTimeout(() => socket.destroy(), this.timeoutMs)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(deadline)
      this.sockets.delete(socket)
      controller.abort()
    })
    const reply = (r: CliResult) => {
      if (socket.destroyed || !socket.writable) return
      // Ends our side, then drops a peer that never closes its own.
      socket.end(`${JSON.stringify(r)}\n`, () => setTimeout(() => socket.destroy(), 1000).unref())
    }
    const take = (line: Buffer) => {
      done = true
      clearTimeout(deadline)
      void this.dispatch(socket, line, controller.signal).then(reply, () => reply({ exit: EXIT.ERROR, error: 'internal error' }))
    }
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      const nl = chunk.indexOf(0x0a)
      const part = nl >= 0 ? chunk.subarray(0, nl) : chunk
      size += part.length
      if (size > this.maxBytes) {
        done = true
        clearTimeout(deadline)
        reply({ exit: EXIT.USAGE, error: 'request too large' })
        return
      }
      chunks.push(part)
      if (nl >= 0) take(Buffer.concat(chunks))
    })
  }

  private async dispatch(socket: Socket, line: Buffer, signal: AbortSignal): Promise<CliResult> {
    let req: unknown
    try {
      req = JSON.parse(line.toString('utf8'))
    } catch {
      return { exit: EXIT.USAGE, error: 'bad request' }
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return { exit: EXIT.USAGE, error: 'bad request' }
    const { token, cmd, args } = req as { token?: unknown; cmd?: unknown; args?: unknown }
    const tileId = this.authenticate(token)
    if (tileId === null) return FORBIDDEN
    const who = this.target.identify(tileId)
    if (!who) return FORBIDDEN
    if (typeof cmd !== 'string' || (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))) {
      return { exit: EXIT.USAGE, error: 'bad request' }
    }
    let set = this.active.get(tileId)
    if (!set) this.active.set(tileId, (set = new Set()))
    set.add(socket)
    try {
      return await this.target.run(who, { cmd, args: args as Record<string, unknown> | undefined }, signal)
    } finally {
      set.delete(socket)
      if (set.size === 0 && this.active.get(tileId) === set) this.active.delete(tileId)
    }
  }
}
