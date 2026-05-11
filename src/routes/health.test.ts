import { describe, it, expect, vi } from 'vitest'
import { renderHealth } from './health.js'
import type { TenantStore } from '../tenants/store.js'

function fakeStore(tenants: number): TenantStore {
  return {
    list: async () => Array.from({ length: tenants }, (_, i) => ({
      name: `t${i}`,
      tokenHash: 'x',
      createdAt: '2026-05-10T00:00:00.000Z',
    })),
    add: async () => {},
    remove: async () => false,
    findByToken: async () => null,
  }
}

describe('renderHealth', () => {
  it('returns ok=true with tenant count and uptime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    const startedAt = Date.now() - 5_000 // 5 seconds ago
    const body = await renderHealth({ store: fakeStore(3), startedAtMs: startedAt, version: '0.1.0' })
    expect(body.ok).toBe(true)
    expect(body.version).toBe('0.1.0')
    expect(body.tenants).toBe(3)
    expect(body.uptimeSec).toBe(5)
    vi.useRealTimers()
  })

  it('reports zero tenants when store is empty', async () => {
    const body = await renderHealth({ store: fakeStore(0), startedAtMs: Date.now(), version: '0.1.0' })
    expect(body.tenants).toBe(0)
  })
})
