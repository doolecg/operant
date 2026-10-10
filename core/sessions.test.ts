import { describe, expect, it } from 'vitest'
import { inheritedEnv, SessionManager, type Pty, type PtyFactory } from './sessions'

class FakePty implements Pty {
  written: string[] = []
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number }) => void = () => {}
  write(d: string) {
    this.written.push(d)
  }
  resize() {}
  kill() {
    this.exitCb({ exitCode: 0 })
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  emitData(d: string) {
    this.dataCb(d)
  }
}

describe('session manager', () => {
  it('starts a keyed session, types its command, keeps output and reports the exit', () => {
    const ptys: FakePty[] = []
    const spawn: PtyFactory = () => {
      const p = new FakePty()
      ptys.push(p)
      return p
    }
    const sessions = new SessionManager(spawn)
    const events: string[] = []
    sessions.on('data', (key, data) => events.push(`data:${key}:${data}`))
    sessions.on('exit', (key, code) => events.push(`exit:${key}:${code}`))
    sessions.start({ key: 'scratch:1', cwd: '/code', command: 'claude --model sonnet' })
    expect(sessions.isRunning('scratch:1')).toBe(true)
    expect(ptys[0]!.written).toEqual(['claude --model sonnet\r'])
    ptys[0]!.emitData('hello')
    expect(sessions.buffer('scratch:1')).toBe('hello')
    sessions.stop('scratch:1')
    expect(sessions.isRunning('scratch:1')).toBe(false)
    expect(events).toEqual(['data:scratch:1:hello', 'exit:scratch:1:0'])
  })
})

describe('inherited environment', () => {
  it('drops the markers of an outer Claude Code session but keeps the user settings', () => {
    const env = inheritedEnv({
      PATH: 'p',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CONFIG_DIR: 'c',
      OPERANT_TOKEN: 'o',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(env).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'c' })
  })
})
