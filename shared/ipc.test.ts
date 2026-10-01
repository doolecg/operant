import { describe, expect, it } from 'vitest'
import { IpcError, decodeIpcError, encodeIpcError, CORE_CHANNELS, MAIN_CHANNELS } from './ipc'

describe('ipc errors', () => {
  it('carries the code through the message Electron passes across the bridge', () => {
    const wire = new Error(`Error invoking remote method 'jobs:approve': Error: ${encodeIpcError('CONFLICT', 'Job 4 is todo, not in review')}`)
    const err = decodeIpcError(wire)
    expect(err).toBeInstanceOf(IpcError)
    expect(err).toMatchObject({ code: 'CONFLICT', message: 'Job 4 is todo, not in review' })
  })

  it('treats anything else as INTERNAL and strips the Electron prefix', () => {
    expect(decodeIpcError(new Error("Error invoking remote method 'x': Error: boom"))).toMatchObject({ code: 'INTERNAL', message: 'boom' })
    expect(decodeIpcError('plain')).toMatchObject({ code: 'INTERNAL', message: 'plain' })
  })

  it('decodes the message the preload rethrows (contextBridge keeps only the message of an Error)', () => {
    const bridged = new Error(encodeIpcError('CONFLICT', 'Job 4 is todo, not in review'))
    expect(decodeIpcError(bridged)).toMatchObject({ code: 'CONFLICT', message: 'Job 4 is todo, not in review' })
  })

  it('keeps the channel lists free of overlap', () => {
    const all = [...CORE_CHANNELS, ...MAIN_CHANNELS]
    expect(new Set(all).size).toBe(all.length)
  })
})
