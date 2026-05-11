import { describe, it, expect, afterEach, vi } from 'vitest'
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
  // Defensive: a thrown expect() in any test would otherwise leak faked
  // timers into the next test (or test file in the same worker).
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns ok=true with tenant count and uptime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    const startedAt = Date.now() - 5_000 // 5 seconds ago
    const body = await renderHealth({ store: fakeStore(3), startedAtMs: startedAt, version: '0.1.0' })
    expect(body.ok).toBe(true)
    expect(body.version).toBe('0.1.0')
    expect(body.tenants).toBe(3)
    expect(body.uptimeSec).toBe(5)
  })

  it('reports zero tenants when store is empty', async () => {
    const body = await renderHealth({ store: fakeStore(0), startedAtMs: Date.now(), version: '0.1.0' })
    expect(body.tenants).toBe(0)
  })

  it('clamps uptime at 0 when startedAtMs is in the future', async () => {
    const future = Date.now() + 60_000
    const body = await renderHealth({ store: fakeStore(0), startedAtMs: future, version: '0.1.0' })
    expect(body.uptimeSec).toBe(0)
  })

  it('propagates errors from store.list() (does not swallow them as ok:false)', async () => {
    const failing: TenantStore = {
      list: async () => {
        throw new Error('store unavailable')
      },
      add: async () => {},
      remove: async () => false,
      findByToken: async () => null,
    }
    await expect(
      renderHealth({ store: failing, startedAtMs: Date.now(), version: '0.1.0' }),
    ).rejects.toThrow(/store unavailable/)
  })
})
