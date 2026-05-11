import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdmin, type AdminRouteDeps } from './admin.js'
import { openJsonStore, type TenantStore } from '../tenants/store.js'

const ADMIN_PASSWORD = 'super-secret-password-1234'
const AUTH_HEADER = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')

let dir: string
let store: TenantStore
let deps: AdminRouteDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sms-edge-admin-'))
  store = await openJsonStore(join(dir, 'tenants.json'))
  deps = { store, adminPassword: ADMIN_PASSWORD }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('admin auth', () => {
  it('returns 401 with WWW-Authenticate when no auth header', async () => {
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: {}, body: null,
    }, deps)
    expect(res.status).toBe(401)
    expect(res.headers['WWW-Authenticate']).toMatch(/Basic/)
  })

  it('returns 401 on wrong password', async () => {
    const wrong = 'Basic ' + Buffer.from('admin:wrong').toString('base64')
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: wrong }, body: null,
    }, deps)
    expect(res.status).toBe(401)
  })

  it('accepts case-insensitive Authorization header name', async () => {
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { Authorization: AUTH_HEADER }, body: null,
    }, deps)
    expect(res.status).toBe(200)
  })

  it('rejects wrong username', async () => {
    const bad = 'Basic ' + Buffer.from(`root:${ADMIN_PASSWORD}`).toString('base64')
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: bad }, body: null,
    }, deps)
    expect(res.status).toBe(401)
  })
})

describe('GET /admin', () => {
  it('redirects to /admin/tenants', async () => {
    const res = await handleAdmin({
      method: 'GET', path: '/admin', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    expect(res.status).toBe(302)
    expect(res.headers['Location']).toBe('/admin/tenants')
  })
})

describe('GET /admin/tenants', () => {
  it('renders an empty list when no tenants', async () => {
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toMatch(/text\/html/)
    expect(res.body).toMatch(/No tenants/i)
    expect(res.body).toMatch(/Add tenant/i)
  })

  it('renders existing tenants with delete forms', async () => {
    await store.add('acme', 'somehash')
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    expect(res.body).toMatch(/acme/)
    expect(res.body).toMatch(/\/admin\/tenants\/acme\/delete/)
    expect(res.body).toMatch(/name="csrf"/)
  })
})

describe('POST /admin/tenants', () => {
  async function getCsrf(): Promise<string> {
    const res = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    const match = res.body.match(/name="csrf" value="([^"]+)"/)
    if (!match) throw new Error('no csrf token in response')
    return match[1]!
  }

  it('creates a tenant, shows the one-time token, hashes on disk', async () => {
    const csrf = await getCsrf()
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=acme&csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(200)
    expect(res.body).toMatch(/Tenant 'acme' created/)
    const tokenMatch = res.body.match(/<code class="token">([^<]+)<\/code>/)
    expect(tokenMatch).toBeTruthy()
    const token = tokenMatch![1]!
    expect(token.length).toBeGreaterThanOrEqual(43) // 32-byte base64url

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('acme')
    expect(list[0]?.tokenHash).not.toBe(token)
    expect(list[0]?.tokenHash.startsWith('scrypt$')).toBe(true)
  })

  it('rejects duplicate name', async () => {
    await store.add('acme', 'somehash')
    const csrf = await getCsrf()
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=acme&csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(400)
    expect(res.body).toMatch(/already exists/)
  })

  it.each([
    ['', /required/],
    ['ABC', /lowercase/],
    ['has spaces', /invalid/],
    ['-leading-dash', /invalid/],
    ['x', /at least 2/],
    ['a'.repeat(33), /at most 32/],
  ])('rejects name %s', async (name, pattern) => {
    const csrf = await getCsrf()
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=${encodeURIComponent(name)}&csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(400)
    expect(res.body).toMatch(pattern)
  })

  it('rejects POST without CSRF token', async () => {
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=acme',
    }, deps)
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/CSRF/i)
  })

  it('rejects POST with wrong CSRF token', async () => {
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=acme&csrf=bogus',
    }, deps)
    expect(res.status).toBe(403)
  })

  it('trims leading and trailing whitespace from the tenant name', async () => {
    const csrf = await getCsrf()
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=${encodeURIComponent('  acme  ')}&csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(200)
    const list = await store.list()
    expect(list[0]?.name).toBe('acme') // trimmed, no leading/trailing spaces
  })

  it('maps a concurrent-duplicate race to the same 400 page', async () => {
    // Both requests pass the pre-check (existing.some -> false), then race on
    // store.add. The first wins; the second sees the store throw and must be
    // mapped to a 400 by postCreate, NOT propagate as an uncaught 500.
    const csrf = await getCsrf()
    const submit = () =>
      handleAdmin({
        method: 'POST', path: '/admin/tenants',
        headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
        body: `name=acme&csrf=${encodeURIComponent(csrf)}`,
      }, deps)
    const [a, b] = await Promise.all([submit(), submit()])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 400])
    const loser = a.status === 400 ? a : b
    expect(loser.body).toMatch(/already exists/)
    // Exactly one tenant landed.
    expect(await store.list()).toHaveLength(1)
  })
})

describe('POST /admin/tenants/:name/delete', () => {
  it('removes the tenant', async () => {
    await store.add('acme', 'somehash')
    const getRes = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    const csrf = getRes.body.match(/name="csrf" value="([^"]+)"/)![1]!

    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants/acme/delete',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(302)
    expect(res.headers['Location']).toBe('/admin/tenants')
    expect(await store.list()).toHaveLength(0)
  })

  it('returns 404 when tenant does not exist', async () => {
    const getRes = await handleAdmin({
      method: 'GET', path: '/admin/tenants', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    const csrf = getRes.body.match(/name="csrf" value="([^"]+)"/)![1]!
    const res = await handleAdmin({
      method: 'POST', path: '/admin/tenants/missing/delete',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(csrf)}`,
    }, deps)
    expect(res.status).toBe(404)
  })
})

describe('unknown admin paths', () => {
  it('returns 404 for unknown admin URLs', async () => {
    const res = await handleAdmin({
      method: 'GET', path: '/admin/wat', headers: { authorization: AUTH_HEADER }, body: null,
    }, deps)
    expect(res.status).toBe(404)
  })
})
