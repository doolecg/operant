import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { debugClient } from './browser-debugger'

class FakeDebugger extends EventEmitter {
  attached = false
  attaches = 0
  sent: string[] = []
  isAttached() {
    return this.attached
  }
  attach() {
    this.attached = true
    this.attaches++
  }
  detach() {
    this.attached = false
    this.emit('detach', {}, 'client')
  }
  sendCommand(method: string) {
    this.sent.push(method)
    return Promise.resolve({})
  }
}

class FakeWc extends EventEmitter {
  debugger = new FakeDebugger()
  isDestroyed() {
    return false
  }
}

describe('shared debugger', () => {
  it('attaches once for two clients, fans messages out and detaches with the last one', async () => {
    const wc = new FakeWc()
    const a = debugClient(wc as unknown as WebContents)
    const b = debugClient(wc as unknown as WebContents)
    const seenA: string[] = []
    const seenB: string[] = []
    a.onMessage((m) => void seenA.push(m))
    b.onMessage((m) => void seenB.push(m))
    a.onAttach(async () => void (await wc.debugger.sendCommand('Page.enable')))
    b.onAttach(async () => void (await wc.debugger.sendCommand('Runtime.enable')))
    expect(await Promise.all([a.ensure(), b.ensure()])).toEqual([true, true])
    expect(wc.debugger.attaches).toBe(1)
    expect(wc.debugger.sent.sort()).toEqual(['Page.enable', 'Runtime.enable'])
    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert' })
    expect(seenA).toEqual(['Page.javascriptDialogOpening'])
    expect(seenB).toEqual(['Page.javascriptDialogOpening'])
    a.release()
    expect(wc.debugger.attached).toBe(true)
    b.release()
    expect(wc.debugger.attached).toBe(false)
  })

  it('runs the init again after the debugger was taken away', async () => {
    const wc = new FakeWc()
    const c = debugClient(wc as unknown as WebContents)
    let inits = 0
    c.onAttach(() => void inits++)
    await c.ensure()
    wc.debugger.attached = false
    wc.debugger.emit('detach', {}, 'replaced')
    expect(await c.ensure()).toBe(true)
    expect(inits).toBe(2)
    c.release()
  })
})
