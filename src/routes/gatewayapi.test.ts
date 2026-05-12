import { describe, it, expect } from 'vitest'
import { handleGatewayApi, type GatewayApiRouteDeps } from './gatewayapi.js'
import type { SmsClient, SendInput, SendResult } from '@itkujo/sms-core'

function fakeClient(impl: (input: SendInput) => Promise<SendResult>): SmsClient {
  return { send: impl, getStatus: async () => ({ ok: false, error: { type: 'Network', cause: new Error('not used') } }) } as unknown as SmsClient
}

const baseDeps = (overrides: Partial<GatewayApiRouteDeps> = {}): GatewayApiRouteDeps => ({
  client: fakeClient(async () => ({ ok: true, messageId: 'msg-1', deviceId: 'dev-1', state: 'Pending' })),
  audit: { onAuditLog: () => {}, emitRequestReceived: () => {}, emitRequestCompleted: () => {} },
  ...overrides,
})

const validBody = (overrides: Record<string, unknown> = {}) => ({
  sender: 'Logto',
  message: 'Your sign-in code is 123456. The code will remain active for 10 minutes.',
  recipients: [{ msisdn: '+12125551234' }],
  ...overrides,
})

describe('handleGatewayApi', () => {
  it('returns 200 with GatewayAPI-shaped response on success', async () => {
    const res = await handleGatewayApi({ body: validBody(), peerIp: '203.0.113.5' }, baseDeps())
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as { ids: unknown[]; usage: Record<string, unknown> }
    // Logto's connector only checks the 2xx status code, but a GatewayAPI-shaped
    // body keeps the contract honest for any other client that POSTs the same
    // way and parses the response.
    expect(Array.isArray(parsed.ids)).toBe(true)
    expect(parsed.ids).toHaveLength(1)
    expect(parsed.usage).toBeDefined()
  })

  it('translates the GatewayAPI envelope to a sms-core Generic send', async () => {
    let captured: SendInput | undefined
    const deps = baseDeps({
      client: fakeClient(async (input) => {
        captured = input
        return { ok: true, messageId: 'msg-1', deviceId: 'dev-1', state: 'Pending' }
      }),
    })
    await handleGatewayApi({
      body: validBody({ message: 'Hello world', recipients: [{ msisdn: '+15551234567' }] }),
      peerIp: '203.0.113.5',
    }, deps)
    expect(captured).toBeDefined()
    expect(captured!.to).toBe('+15551234567')
    expect(captured!.type).toBe('Generic')
    expect(captured!.payload).toEqual({ text: 'Hello world' })
    // peerIp threaded through for ip-based rate limiting.
    expect(captured!.ip).toBe('203.0.113.5')
  })

  it('returns 400 when body is not a JSON object', async () => {
    const res = await handleGatewayApi({ body: 'not-an-object', peerIp: '203.0.113.5' }, baseDeps())
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.reason).toMatch(/JSON object/i)
  })

  it.each([
    ['missing message', { sender: 'X', recipients: [{ msisdn: '+12125551234' }] }, /"message"/],
    ['message empty string', { sender: 'X', message: '', recipients: [{ msisdn: '+12125551234' }] }, /"message"/],
    ['missing recipients', { sender: 'X', message: 'hi' }, /"recipients"/],
    ['recipients not an array', { sender: 'X', message: 'hi', recipients: { msisdn: '+1' } }, /"recipients"/],
    ['recipients empty', { sender: 'X', message: 'hi', recipients: [] }, /"recipients"/],
    ['recipient missing msisdn', { sender: 'X', message: 'hi', recipients: [{}] }, /msisdn/],
    ['msisdn not a string', { sender: 'X', message: 'hi', recipients: [{ msisdn: 12125551234 }] }, /msisdn/],
  ])('returns 400 on %s', async (_label, body, pattern) => {
    const res = await handleGatewayApi({ body, peerIp: '203.0.113.5' }, baseDeps())
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.reason).toMatch(pattern)
  })

  // GatewayAPI's wire shape allows multiple recipients; Logto's connector
  // always sends exactly one. To keep per-call rate-limiting accurate and
  // avoid silently dropping recipients, we reject >1 recipients explicitly.
  it('returns 400 when more than one recipient is supplied', async () => {
    const res = await handleGatewayApi({
      body: validBody({ recipients: [{ msisdn: '+15551234567' }, { msisdn: '+15557654321' }] }),
      peerIp: '203.0.113.5',
    }, baseDeps())
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.reason).toMatch(/single recipient/i)
  })

  it('returns 400 InvalidPhone when sms-core rejects the phone', async () => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: 'InvalidPhone', reason: 'not US/CA E.164' } })),
    })
    const res = await handleGatewayApi({
      body: validBody({ recipients: [{ msisdn: '+440000000000' }] }),
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.type).toBe('InvalidPhone')
  })

  it('returns 429 with Retry-After on RateLimit', async () => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: 'RateLimit', key: 'phone', retryAfterSec: 60 } })),
    })
    const res = await handleGatewayApi({
      body: validBody(),
      peerIp: '203.0.113.5',
    }, deps)
    expect(res.status).toBe(429)
    expect(res.headers['Retry-After']).toBe('60')
  })

  it('returns 502 when SMSGate returns a 4xx Provider error', async () => {
    const deps = baseDeps({
      client: fakeClient(async () => ({ ok: false, error: { type: 'Provider', status: 422, providerMessage: 'bad request' } })),
    })
    const res = await handleGatewayApi({ body: validBody(), peerIp: '203.0.113.5' }, deps)
    expect(res.status).toBe(502)
  })
})
