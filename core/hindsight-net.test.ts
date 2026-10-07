import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { generateApiKey, isLoopbackHost, isTailscale, listAdapters } from './hindsight-net'

const info = (address: string, family: string | number, internal = false) => ({ address, family, internal }) as unknown as NetworkInterfaceInfo

describe('hindsight network adapters', () => {
  it('lists non-internal IPv4 adapters (family IPv4 or 4), labels Tailscale, and adds this PC and all adapters', () => {
    const list = listAdapters(() => ({
      Ethernet: [info('192.168.1.20', 'IPv4'), info('fe80::1', 'IPv6')],
      Tailscale: [info('100.101.102.103', 4)],
      Loopback: [info('127.0.0.1', 'IPv4', true)],
      Down: undefined,
    }))
    expect(list.map((a) => a.address)).toEqual(['127.0.0.1', '192.168.1.20', '100.101.102.103', '0.0.0.0'])
    expect(list[0]).toMatchObject({ loopback: true, all: false })
    expect(list[1]).toMatchObject({ tailscale: false, label: 'Ethernet (192.168.1.20)' })
    expect(list[2]).toMatchObject({ tailscale: true })
    expect(list[2]!.label).toContain('Tailscale')
    expect(list[3]).toMatchObject({ all: true })
    expect(list[3]!.label).toBe('All adapters (0.0.0.0)')
  })

  it('knows the Tailscale range and loopback hosts', () => {
    expect(isTailscale('100.64.0.1')).toBe(true)
    expect(isTailscale('100.127.255.254')).toBe(true)
    expect(isTailscale('100.63.0.1')).toBe(false)
    expect(isTailscale('100.128.0.1')).toBe(false)
    expect(isTailscale('10.0.0.1')).toBe(false)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })

  it('generates long distinct keys', () => {
    expect(generateApiKey()).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(generateApiKey()).not.toBe(generateApiKey())
  })
})
