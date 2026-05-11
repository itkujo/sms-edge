import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createAuditLogger,
  withRequestContext,
  type AuditLogger,
} from './logger.js'

const NOW = new Date('2026-05-10T12:00:00.000Z')

let logged: string[] = []
let logger: AuditLogger

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  logged = []
  logger = createAuditLogger({
    write: (line) => { logged.push(line) },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createAuditLogger', () => {
  it('emits sms-core AuditEvents as one-line JSON with ts + level=info', () => {
    logger.onAuditLog({ kind: 'send.attempt', to: '+15551234567', type: 'SignIn', purpose: 'otp' })
    expect(logged).toHaveLength(1)
    const parsed = JSON.parse(logged[0]!)
    expect(parsed).toMatchObject({
      ts: NOW.toISOString(),
      level: 'info',
      kind: 'send.attempt',
      to: '+15551234567',
      type: 'SignIn',
      purpose: 'otp',
    })
  })

  it('emits send.blocked with level=warn', () => {
    logger.onAuditLog({ kind: 'send.blocked', to: '+15551234567', reason: 'bad', errorType: 'InvalidPhone' })
    expect(JSON.parse(logged[0]!).level).toBe('warn')
  })

  it('emits send.failure with level=error', () => {
    logger.onAuditLog({ kind: 'send.failure', to: '+15551234567', errorType: 'Network' })
    expect(JSON.parse(logged[0]!).level).toBe('error')
  })

  it('emits bridge edge.request.received via helper', () => {
    logger.emitRequestReceived({
      method: 'POST', path: '/sms', to: '+15551234567', type: 'SignIn',
    })
    const parsed = JSON.parse(logged[0]!)
    expect(parsed).toMatchObject({
      event: 'edge.request.received',
      method: 'POST',
      path: '/sms',
      to: '+15551234567',
      type: 'SignIn',
      level: 'info',
    })
  })

  it('emits bridge edge.request.completed with status+duration, level depends on status', () => {
    logger.emitRequestCompleted({ status: 200, durationMs: 123 })
    expect(JSON.parse(logged[0]!).level).toBe('info')

    logger.emitRequestCompleted({ status: 400, durationMs: 1 })
    expect(JSON.parse(logged[1]!).level).toBe('warn')

    logger.emitRequestCompleted({ status: 503, durationMs: 5 })
    expect(JSON.parse(logged[2]!).level).toBe('error')
  })
})

describe('withRequestContext', () => {
  it('threads tenant and reqId into events emitted inside the callback', async () => {
    await withRequestContext({ tenant: 'acme', reqId: 'req_xyz' }, async () => {
      logger.emitRequestReceived({ method: 'POST', path: '/sms' })
      logger.onAuditLog({ kind: 'send.attempt', to: '+15551234567', type: 'SignIn', purpose: 'otp' })
    })
    expect(JSON.parse(logged[0]!)).toMatchObject({ tenant: 'acme', reqId: 'req_xyz' })
    expect(JSON.parse(logged[1]!)).toMatchObject({ tenant: 'acme', reqId: 'req_xyz' })
  })

  it('omits tenant/reqId when called outside a request context', () => {
    logger.onAuditLog({ kind: 'send.attempt', to: '+15551234567', type: 'SignIn', purpose: 'otp' })
    const parsed = JSON.parse(logged[0]!)
    expect(parsed.tenant).toBeUndefined()
    expect(parsed.reqId).toBeUndefined()
  })

  it('isolates contexts across concurrent requests', async () => {
    await Promise.all([
      withRequestContext({ tenant: 'acme', reqId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        logger.emitRequestReceived({ method: 'POST', path: '/sms' })
      }),
      withRequestContext({ tenant: 'beta', reqId: 'b' }, async () => {
        logger.emitRequestReceived({ method: 'POST', path: '/sms' })
      }),
    ])
    // Assert paired (tenant, reqId) so a context-leak where one emit picks
    // up the OTHER request's reqId would fail, not pass.
    const pairs = logged
      .map((l) => JSON.parse(l))
      .map((p) => [p.tenant, p.reqId])
      .sort()
    expect(pairs).toEqual([['acme', 'a'], ['beta', 'b']])
  })
})
