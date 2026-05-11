import { describe, it, expect } from 'vitest'
import { handleSms, type SmsRouteDeps } from './sms.js'
import type { SmsClient, SendInput, SendResult } from '@itkujo/sms-core'

function fakeClient(impl: (input: SendInput) => Promise<SendResult>): SmsClient {
  return { send: impl, getStatus: async () => ({ ok: false, error: { type: 'Network', cause: new Error('not used') } }) } as unknown as SmsClient
}

const baseDeps = (overrides: Partial<SmsRouteDeps> = {}): SmsRouteDeps => ({
  client: fakeClient(async () => ({ ok: true, messageId: 'm1', deviceId: 'd1', state: 'Pending' })),
  audit: { onAuditLog: () => {}, emitRequestReceived: () => {}, emitRequestCompleted: () => {} },
  ...overrides,
})

describe('handleSms', () => {
  it('returns 200 with SendResult on success', async () => {
    const res = await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '123456' } },
      peerIp: '203.0.113.5',
    }, baseDeps())
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, messageId: 'm1', deviceId: 'd1', state: 'Pending' })
  })

  it('returns 400 when body is not an object', async () => {
    const res = await handleSms({ body: 'string-body', peerIp: '203.0.113.5' }, baseDeps())
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    // Body-shape errors are reported as InvalidRequest (distinct from the
    // sms-core InvalidPhone variant) so consumers can distinguish.
    expect(body.error.type).toBe('InvalidRequest')
    expect(body.error.reason).toMatch(/JSON object/)
  })

  it.each([
    ['missing to', { type: 'SignIn', payload: {} }, /"to"/],
    ['non-string to', { to: 42, type: 'SignIn', payload: {} }, /"to"/],
    ['missing type', { to: '+12125551234', payload: {} }, /"type"/],
    ['missing payload', { to: '+12125551234', type: 'SignIn' }, /"payload"/],
    ['payload not an object', { to: '+12125551234', type: 'SignIn', payload: 'x' }, /"payload"/],
    ['invalid purpose', { to: '+12125551234', type: 'SignIn', payload: {}, purpose: 'spam' }, /"purpose"/],
    ['invalid ip', { to: '+12125551234', type: 'SignIn', payload: {}, ip: 42 }, /"ip"/],
  ])('returns 400 on %s', async (_label, body, pattern) => {
    const res = await handleSms({ body, peerIp: '203.0.113.5' }, baseDeps())
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.reason).toMatch(pattern)
  })

  it('passes peerIp through to sms-core when body.ip is not set', async () => {
    const captured: SendInput[] = []
    const deps = baseDeps({
      client: fakeClient(async (input) => {
        captured.push(input)
        return { ok: true, messageId: 'm1', deviceId: 'd1', state: 'Pending' }
      }),
    })
    await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '123' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(captured[0]?.ip).toBe('203.0.113.5')
  })

  it('prefers body.ip over peerIp when both are present', async () => {
    const captured: SendInput[] = []
    const deps = baseDeps({
      client: fakeClient(async (input) => {
        captured.push(input)
        return { ok: true, messageId: 'm1', deviceId: 'd1', state: 'Pending' }
      }),
    })
    await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '123' }, ip: '198.51.100.1' },
      peerIp: '203.0.113.5',
    }, deps)
    expect(captured[0]?.ip).toBe('198.51.100.1')
  })

  it.each([
    ['InvalidPhone', 400],
    ['PremiumPrefixBlocked', 400],
    ['SequentialPatternBlocked', 400],
  ])('returns %s with status %d', async (errType, status) => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: errType, reason: 'r' } as never })),
    })
    const res = await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '1' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(status)
    expect(JSON.parse(res.body).error.type).toBe(errType)
  })

  it('returns 429 with Retry-After on RateLimit', async () => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: 'RateLimit', key: 'phone', retryAfterSec: 120 } })),
    })
    const res = await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '1' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(429)
    expect(res.headers['Retry-After']).toBe('120')
  })

  it.each([
    [{ type: 'Provider', status: 400, providerMessage: 'bad request' }, 502],
    [{ type: 'Provider', status: 500, providerMessage: 'down' }, 503],
    [{ type: 'Provider', status: 503, providerMessage: 'maintenance' }, 503],
    [{ type: 'Network', cause: new Error('econnrefused') }, 503],
    [{ type: 'Timeout', timeoutMs: 15000 }, 504],
    [{ type: 'Config', reason: 'bad' }, 500],
  ])('maps %j to status %d', async (error, status) => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: error as never })),
    })
    const res = await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '1' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(status)
  })

  it('serializes Network.cause safely (does not crash on circular references)', async () => {
    // Construct a circular cause -- realistic for fetch/undici errors that
    // attach the request, which references the response, which references...
    const circular: { self?: unknown } = {}
    circular.self = circular
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: 'Network', cause: circular } })),
    })
    const res = await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '1' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(503)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.type).toBe('Network')
    // The cause is coerced to a string via String(cause), so the wire payload
    // is always JSON-serializable.
    expect(typeof parsed.error.reason).toBe('string')
  })

  it('emits edge.request.completed even when the body cannot be parsed', async () => {
    const completed: Array<{ status: number; durationMs: number }> = []
    const deps = baseDeps({
      audit: {
        onAuditLog: () => {},
        emitRequestReceived: () => {},
        emitRequestCompleted: (f) => { completed.push(f) },
      },
    })
    await handleSms({ body: 'not an object', peerIp: '203.0.113.5' }, deps)
    expect(completed).toHaveLength(1)
    expect(completed[0]?.status).toBe(400)
  })

  it('calls emitRequestCompleted with status + durationMs', async () => {
    const completed: Array<{ status: number; durationMs: number }> = []
    const deps = baseDeps({
      audit: {
        onAuditLog: () => {},
        emitRequestReceived: () => {},
        emitRequestCompleted: (f) => { completed.push(f) },
      },
    })
    await handleSms({
      body: { to: '+12125551234', type: 'SignIn', payload: { code: '1' } },
      peerIp: '203.0.113.5',
    }, deps)
    expect(completed).toHaveLength(1)
    expect(completed[0]?.status).toBe(200)
    expect(completed[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })
})
