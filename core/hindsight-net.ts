import { randomBytes } from 'node:crypto'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { HindsightAdapter } from '../shared/types'

export const isLoopbackHost = (host: string): boolean => /^127\./.test(host) || host === 'localhost' || host === '::1'

// Tailscale hands out addresses in 100.64.0.0/10.
export function isTailscale(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

// The addresses a shared server can bind: this PC only, each IPv4 adapter that is up, and every adapter.
export function listAdapters(ni: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): HindsightAdapter[] {
  const out: HindsightAdapter[] = [{ address: '127.0.0.1', label: 'This PC only (127.0.0.1)', tailscale: false, all: false, loopback: true }]
  for (const [name, infos] of Object.entries(ni())) {
    for (const i of infos ?? []) {
      // Node reports the family as 'IPv4' or, in some versions, 4.
      if ((i.family as string | number) !== 'IPv4' && (i.family as string | number) !== 4) continue
      if (i.internal) continue
      const tailscale = isTailscale(i.address)
      out.push({ address: i.address, label: `${name} (${i.address})${tailscale ? ' · Tailscale' : ''}`, tailscale, all: false, loopback: false })
    }
  }
  out.push({ address: '0.0.0.0', label: 'All adapters (0.0.0.0)', tailscale: false, all: true, loopback: false })
  return out
}

export const generateApiKey = (): string => randomBytes(32).toString('base64url')
