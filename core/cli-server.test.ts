import { describe, expect, it } from 'vitest'
import { CliServer } from './cli-server'

const target = { identify: () => ({ crewId: 1 }), run: async () => ({ exit: 0 }) }

describe('CliServer token identity', () => {
  it('whoIs maps a token to its tile and refuses others', () => {
    const s = new CliServer({ target })
    const t7 = s.issueToken(7)
    const t8 = s.issueToken(8)
    expect(s.whoIs(t7)).toBe(7)
    expect(s.whoIs(t8)).toBe(8)
    expect(s.whoIs('0'.repeat(64))).toBeNull()
    expect(s.whoIs('nope')).toBeNull()
    expect(s.whoIs(undefined)).toBeNull()
  })

  it('onRevoke fires on revoke and on replacement, and can be unsubscribed', () => {
    const s = new CliServer({ target })
    const seen: number[] = []
    const off = s.onRevoke((id) => seen.push(id))
    const old = s.issueToken(3)
    s.issueToken(3)
    expect(seen).toEqual([3])
    expect(s.whoIs(old)).toBeNull()
    s.revokeToken(3)
    s.revokeToken(3)
    expect(seen).toEqual([3, 3])
    off()
    s.issueToken(4)
    s.revokeToken(4)
    expect(seen).toEqual([3, 3])
  })
})
