import type { SmsClient, SendInput, SendResult, SmsError } from '@itkujo/sms-core'
import type { AuditLogger } from '../audit/logger.js'

export interface SmsRouteDeps {
  client: SmsClient
  audit: AuditLogger
}

export interface SmsRouteRequest {
  body: unknown
  peerIp: string
}

export interface SmsRouteResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function validateBody(body: unknown): { ok: true; input: SendInput } | { ok: false; reason: string } {
  if (!isObject(body)) return { ok: false, reason: 'body must be a JSON object' }
  if (!isString(body['to'])) return { ok: false, reason: 'field "to" must be a string' }
  if (!isString(body['type'])) return { ok: false, reason: 'field "type" must be a string' }
  if (!isObject(body['payload'])) return { ok: false, reason: 'field "payload" must be a JSON object' }
  if (body['ip'] !== undefined && !isString(body['ip'])) {
    return { ok: false, reason: 'field "ip" must be a string when present' }
  }
  if (body['purpose'] !== undefined && body['purpose'] !== 'otp' && body['purpose'] !== 'transactional') {
    return { ok: false, reason: 'field "purpose" must be "otp" or "transactional" when present' }
  }
  const input: SendInput = {
    to: body['to'],
    type: body['type'] as SendInput['type'],
    payload: body['payload'],
    ...(typeof body['ip'] === 'string' && { ip: body['ip'] }),
    ...(body['purpose'] === 'otp' || body['purpose'] === 'transactional' ? { purpose: body['purpose'] } : {}),
  }
  return { ok: true, input }
}

function statusForError(err: SmsError): number {
  switch (err.type) {
    case 'InvalidPhone':
    case 'PremiumPrefixBlocked':
    case 'SequentialPatternBlocked':
      return 400
    case 'RateLimit':
      return 429
    case 'Provider':
      return err.status >= 500 ? 503 : 502
    case 'Network':
      return 503
    case 'Timeout':
      return 504
    case 'Config':
      return 500
  }
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): SmsRouteResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  }
}

export async function handleSms(req: SmsRouteRequest, deps: SmsRouteDeps): Promise<SmsRouteResponse> {
  const startedAt = Date.now()

  const validation = validateBody(req.body)
  if (!validation.ok) {
    const res = jsonResponse(400, { ok: false, error: { type: 'InvalidPhone', reason: validation.reason } })
    deps.audit.emitRequestCompleted({ status: res.status, durationMs: Date.now() - startedAt })
    return res
  }

  const input: SendInput = {
    ...validation.input,
    ip: validation.input.ip ?? req.peerIp,
  } as SendInput

  const result: SendResult = await deps.client.send(input)

  let response: SmsRouteResponse
  if (result.ok) {
    response = jsonResponse(200, result)
  } else {
    const status = statusForError(result.error)
    const extra: Record<string, string> = result.error.type === 'RateLimit'
      ? { 'Retry-After': String(result.error.retryAfterSec) }
      : {}
    response = jsonResponse(status, { ok: false, error: result.error }, extra)
  }

  deps.audit.emitRequestCompleted({ status: response.status, durationMs: Date.now() - startedAt })
  return response
}
