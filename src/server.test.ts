import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createSmsEdgeServer, type ServerDeps } from './server.js'
import { openJsonStore } from './tenants/store.js'
import { hashToken } from './tenants/hash.js'
import { createAuditLogger } from './audit/logger.js'
import type { SmsClient, SendInput } from '@itkujo/sms-core'

const ADMIN_PASSWORD = 'super-secret-password-1234'
let dir: string
let logged: string[] = []
let lastSent: unknown = null

function fakeClient(): SmsClient {
  return {
    send: async (input: SendInput) => {
      lastSent = input
      return { ok: true, messageId: 'msg-1', deviceId: 'dev-1', state: 'Pending' }
    },
    getStatus: async () => ({ ok: false, error: { type: 'Network', cause: new Error('not used') } }),
  } as unknown as SmsClient
}

async function bootServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const storePath = join(dir, 'tenants.json')
  const store = await openJsonStore(storePath)
  // Pre-seed a tenant whose token is "test-token".
  const hash = await hashToken('test-token')
  await store.add('acme', hash)
  const audit = createAuditLogger({ write: (line) => { logged.push(line) } })
  const deps: ServerDeps = {
    store,
    client: fakeClient(),
    audit,
    adminPassword: ADMIN_PASSWORD,
    version: '0.1.0',
  }
  const server = createSmsEdgeServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sms-edge-server-'))
  logged = []
  lastSent = null
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('GET /health', () => {
  it('returns 200 with healthy body', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; version: string; tenants: number }
      expect(body.ok).toBe(true)
      expect(body.version).toBe('0.1.0')
      expect(body.tenants).toBe(1)
    } finally { await close() }
  })
})

describe('POST /sms', () => {
  it('returns 401 when X-Auth header is missing', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('Unauthorized')
    } finally { await close() }
  })

  it('returns 401 when X-Auth token does not match any tenant', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'wrong-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('Unauthorized')
    } finally { await close() }
  })

  it('returns 200 with a valid token + valid body', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; messageId: string }
      expect(body.ok).toBe(true)
      expect(body.messageId).toBe('msg-1')
      expect(lastSent).toMatchObject({ to: '+12125551234', type: 'SignIn' })
    } finally { await close() }
  })

  // Logto's connector-http-sms sends the configured token in `Authorization`,
  // not `X-Auth`. We accept either to support both Logto and any client that
  // follows the X-Auth convention documented in our README.
  it('accepts Authorization: Bearer <token> as an alternative to X-Auth', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; messageId: string }
      expect(body.ok).toBe(true)
      expect(body.messageId).toBe('msg-1')
    } finally { await close() }
  })

  it('accepts a bare Authorization: <token> (no Bearer prefix) for clients that send the raw token', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(200)
    } finally { await close() }
  })

  it('returns 401 when Authorization header carries an invalid token', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('Unauthorized')
    } finally { await close() }
  })

  it('prefers X-Auth when both X-Auth and Authorization are present', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth': 'test-token',
          authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      // X-Auth wins => valid token => 200, not the 401 the wrong Authorization would yield.
      expect(res.status).toBe(200)
    } finally { await close() }
  })

  it('returns 413 when body exceeds 16 KB', async () => {
    const { url, close } = await bootServer()
    try {
      const big = 'x'.repeat(17_000)
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { text: big } }),
      })
      expect(res.status).toBe(413)
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('PayloadTooLarge')
    } finally { await close() }
  })

  it('returns 400 when body is malformed JSON', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'test-token' },
        body: '{not json',
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { ok: boolean; error: { type: string } }
      expect(body.ok).toBe(false)
      expect(body.error.type).toBe('InvalidRequest')
    } finally { await close() }
  })

  it('tags audit events with tenant + reqId', async () => {
    const { url, close } = await bootServer()
    try {
      await fetch(`${url}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      const events = logged.map((l) => JSON.parse(l))
      const tenants = events.map((e) => e.tenant).filter(Boolean)
      const reqIds = events.map((e) => e.reqId).filter(Boolean)
      expect(tenants).toContain('acme')
      expect(reqIds[0]).toMatch(/^req_[0-9a-f]{16}$/)
    } finally { await close() }
  })
})

describe('GET /admin', () => {
  it('challenges for basic auth', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/admin`, { redirect: 'manual' })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/Basic/)
    } finally { await close() }
  })

  it('redirects to /admin/tenants with valid auth', async () => {
    const { url, close } = await bootServer()
    try {
      const auth = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')
      const res = await fetch(`${url}/admin`, { headers: { authorization: auth }, redirect: 'manual' })
      expect(res.status).toBe(302)
    } finally { await close() }
  })
})

describe('unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/some/path`)
      expect(res.status).toBe(404)
    } finally { await close() }
  })

  it('returns 404 with InternalError-free wire shape on the unknown route', async () => {
    const { url, close } = await bootServer()
    try {
      const res = await fetch(`${url}/some/path`)
      const body = await res.json() as { ok: boolean; error: { type: string; reason: string } }
      expect(body.ok).toBe(false)
      expect(body.error.type).toBe('NotFound')
    } finally { await close() }
  })
})

describe('internal error fallthrough', () => {
  // The outer .catch in createSmsEdgeServer is the safety net for any
  // unexpected throw inside handleRequest. Force a throw by injecting an
  // audit logger whose emitRequestReceived throws; the server must respond
  // 500 with the InternalError envelope rather than hang the connection.
  it('returns 500 InternalError when the request handler throws', async () => {
    const storePath = join(dir, 'tenants.json')
    const store = await openJsonStore(storePath)
    const hash = await hashToken('test-token')
    await store.add('acme', hash)
    const throwingAudit = {
      onAuditLog: () => {},
      emitRequestReceived: () => {
        throw new Error('audit emit blew up')
      },
      emitRequestCompleted: () => {},
    }
    const deps: ServerDeps = {
      store,
      client: fakeClient(),
      audit: throwingAudit,
      adminPassword: ADMIN_PASSWORD,
      version: '0.1.0',
    }
    const server = createSmsEdgeServer(deps)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': 'test-token' },
        body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
      })
      expect(res.status).toBe(500)
      const body = await res.json() as { ok: boolean; error: { type: string } }
      expect(body.ok).toBe(false)
      expect(body.error.type).toBe('InternalError')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
