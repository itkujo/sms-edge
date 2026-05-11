import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openJsonStore, type TenantStore } from './store.js'
import { hashToken } from './hash.js'

let dir: string
let storePath: string
let store: TenantStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sms-edge-store-'))
  storePath = join(dir, 'tenants.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('openJsonStore', () => {
  it('creates an empty store when the file does not exist', async () => {
    store = await openJsonStore(storePath)
    expect(await store.list()).toEqual([])
    const onDisk = JSON.parse(await readFile(storePath, 'utf8'))
    expect(onDisk).toEqual({ version: 1, tenants: [] })
  })

  it('loads existing tenants from a valid file', async () => {
    const hash = await hashToken('test-token')
    await writeFile(storePath, JSON.stringify({
      version: 1,
      tenants: [{ name: 'acme', tokenHash: hash, createdAt: '2026-05-10T00:00:00.000Z' }],
    }))
    store = await openJsonStore(storePath)
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('acme')
  })

  it('refuses to start on unknown file version', async () => {
    await writeFile(storePath, JSON.stringify({ version: 99, tenants: [] }))
    await expect(openJsonStore(storePath)).rejects.toThrow(/version/)
  })

  it('refuses to start on corrupted JSON', async () => {
    await writeFile(storePath, '{not json')
    await expect(openJsonStore(storePath)).rejects.toThrow(/parse/i)
  })

  it('refuses to start on duplicate tenant names', async () => {
    const h = await hashToken('t')
    await writeFile(storePath, JSON.stringify({
      version: 1,
      tenants: [
        { name: 'acme', tokenHash: h, createdAt: '2026-05-10T00:00:00.000Z' },
        { name: 'acme', tokenHash: h, createdAt: '2026-05-10T00:00:01.000Z' },
      ],
    }))
    await expect(openJsonStore(storePath)).rejects.toThrow(/duplicate/i)
  })

  it('refuses to start on malformed tenant entry (missing tokenHash)', async () => {
    await writeFile(storePath, JSON.stringify({
      version: 1,
      tenants: [{ name: 'acme', createdAt: '2026-05-10T00:00:00.000Z' }],
    }))
    await expect(openJsonStore(storePath)).rejects.toThrow(/tokenHash/)
  })
})

describe('TenantStore.add / list / remove', () => {
  beforeEach(async () => {
    store = await openJsonStore(storePath)
  })

  it('adds a tenant and persists it to disk', async () => {
    const hash = await hashToken('tok1')
    await store.add('acme', hash)
    const onDisk = JSON.parse(await readFile(storePath, 'utf8'))
    expect(onDisk.tenants).toHaveLength(1)
    expect(onDisk.tenants[0].name).toBe('acme')
    expect(onDisk.tenants[0].tokenHash).toBe(hash)
    expect(onDisk.tenants[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects adding a duplicate name', async () => {
    const hash = await hashToken('tok1')
    await store.add('acme', hash)
    await expect(store.add('acme', hash)).rejects.toThrow(/exists/)
  })

  it('removes a tenant and persists the deletion', async () => {
    const hash = await hashToken('tok1')
    await store.add('acme', hash)
    expect(await store.remove('acme')).toBe(true)
    expect(await store.list()).toHaveLength(0)
  })

  it('remove returns false when the tenant does not exist', async () => {
    expect(await store.remove('nonexistent')).toBe(false)
  })

  it('serializes concurrent adds via promise chain', async () => {
    const h1 = await hashToken('t1')
    const h2 = await hashToken('t2')
    const h3 = await hashToken('t3')
    await Promise.all([
      store.add('a', h1),
      store.add('b', h2),
      store.add('c', h3),
    ])
    const names = (await store.list()).map((t) => t.name).sort()
    expect(names).toEqual(['a', 'b', 'c'])
    const onDisk = JSON.parse(await readFile(storePath, 'utf8'))
    expect(onDisk.tenants).toHaveLength(3)
  })

  it('writes the file atomically (no .tmp files left behind on success)', async () => {
    const hash = await hashToken('tok1')
    await store.add('acme', hash)
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('sets file mode 0o600 on write (POSIX)', async () => {
    if (process.platform === 'win32') return
    const { stat } = await import('node:fs/promises')
    const hash = await hashToken('tok1')
    await store.add('acme', hash)
    const s = await stat(storePath)
    expect(s.mode & 0o777).toBe(0o600)
  })
})

describe('TenantStore.findByToken', () => {
  beforeEach(async () => {
    store = await openJsonStore(storePath)
  })

  it('returns the matching tenant when the token is correct', async () => {
    const hash = await hashToken('correct-token')
    await store.add('acme', hash)
    const found = await store.findByToken('correct-token')
    expect(found?.name).toBe('acme')
  })

  it('returns null when no tenant matches', async () => {
    const hash = await hashToken('a-token')
    await store.add('acme', hash)
    expect(await store.findByToken('wrong-token')).toBeNull()
  })

  it('returns null when the store is empty', async () => {
    expect(await store.findByToken('any')).toBeNull()
  })

  it('iterates all tenants regardless of order (timing-safe)', async () => {
    // Sanity check: with multiple tenants, lookup still finds the right one.
    const ha = await hashToken('token-a')
    const hb = await hashToken('token-b')
    const hc = await hashToken('token-c')
    await store.add('a', ha)
    await store.add('b', hb)
    await store.add('c', hc)
    expect((await store.findByToken('token-b'))?.name).toBe('b')
    expect((await store.findByToken('token-a'))?.name).toBe('a')
    expect((await store.findByToken('token-c'))?.name).toBe('c')
  })

  it('caches successful lookups so subsequent calls skip scrypt', async () => {
    const hash = await hashToken('cache-test-token')
    await store.add('acme', hash)
    const t0 = Date.now()
    await store.findByToken('cache-test-token')
    const firstMs = Date.now() - t0
    const t1 = Date.now()
    await store.findByToken('cache-test-token')
    const secondMs = Date.now() - t1
    // First call runs scrypt (~100ms); cached second call should be <10ms.
    expect(secondMs).toBeLessThan(firstMs)
    expect(secondMs).toBeLessThan(20)
  })

  it('removes a tenant invalidates its cache entry', async () => {
    const hash = await hashToken('rm-token')
    await store.add('acme', hash)
    await store.findByToken('rm-token') // prime the cache
    await store.remove('acme')
    expect(await store.findByToken('rm-token')).toBeNull()
  })
})
