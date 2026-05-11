import { describe, it, expect } from 'vitest'
import { hashToken, verifyToken } from './hash.js'

describe('hashToken / verifyToken', () => {
  it('round-trips a token successfully', async () => {
    const token = 'Hx_K8vw3hF1Lp2OqRsTuVwXyZ012345abcdefghij_k'
    const stored = await hashToken(token)
    expect(await verifyToken(token, stored)).toBe(true)
  })

  it('produces a self-describing hash string with the expected format', async () => {
    const stored = await hashToken('any-token')
    expect(stored).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
  })

  it('produces different hashes for the same token (different salt)', async () => {
    const t = 'same-token'
    const h1 = await hashToken(t)
    const h2 = await hashToken(t)
    expect(h1).not.toBe(h2)
    // ...but both verify
    expect(await verifyToken(t, h1)).toBe(true)
    expect(await verifyToken(t, h2)).toBe(true)
  })

  it('rejects an incorrect token', async () => {
    const stored = await hashToken('correct')
    expect(await verifyToken('incorrect', stored)).toBe(false)
  })

  it('returns false (does not throw) on malformed stored hash', async () => {
    expect(await verifyToken('any', 'not-a-hash-format')).toBe(false)
    expect(await verifyToken('any', 'scrypt$invalid-params$salt$key')).toBe(false)
    expect(await verifyToken('any', '')).toBe(false)
  })

  it('returns false on unknown algorithm prefix', async () => {
    expect(await verifyToken('any', 'argon2$N=16$salt$key')).toBe(false)
  })

  it('handles unicode tokens (defensive, though we generate ASCII)', async () => {
    const t = 'cafe\u00e9' // contains an accented char
    const stored = await hashToken(t)
    expect(await verifyToken(t, stored)).toBe(true)
    expect(await verifyToken('cafe', stored)).toBe(false)
  })
})
