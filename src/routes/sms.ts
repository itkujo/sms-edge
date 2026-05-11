import type { SmsClient, SendInput, SendResult, SmsError } from '@itkujo/sms-core'
import type { AuditLogger } from '../audit/logger.js'

/** Dependencies for the SMS data-plane handler. */
export interface SmsRouteDeps {
  client: SmsClient
  audit: AuditLogger
}

/** Input shape for `handleSms`. `peerIp` comes from the HTTP layer (Task 9)
 * and is used as a fallback when the request body does not specify `ip`. */
export interface SmsRouteRequest {
  body: unknown
  peerIp: string
}

/** Output shape: status code, headers, and serialized body. The HTTP layer
 * (Task 9) writes this directly to the socket. */
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
    default: {
      // Exhaustiveness guard: if sms-core adds a new SmsError variant this
      // line fails to compile, forcing an explicit status decision here.
      const _exhaustive: never = err
      void _exhaustive
      return 500
    }
  }
}

/** Serializes `body` to JSON safely. If serialization throws (circular refs,
 * BigInt, etc.) falls back to a minimal `{ ok: false, error: { type: 'Network', reason: '...' } }`
 * shape so a logging-side payload defect can't crash the request. */
function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): SmsRouteResponse {
  let serialized: string
  try {
    serialized = JSON.stringify(body)
  } catch {
    serialized = JSON.stringify({
      ok: false,
      error: { type: 'Network', reason: 'response body could not be serialized' },
    })
  }
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: serialized,
  }
}

/** Coerces a `SmsError` into a wire-safe shape. Specifically, replaces
 * `Network.cause` (declared `unknown` by sms-core) with a string so the
 * resulting object is guaranteed-serializable. Other variants pass through. */
function wireSafeError(err: SmsError): Record<string, unknown> {
  if (err.type === 'Network') {
    return { type: 'Network', reason: String(err.cause) }
  }
  return { ...err }
}

/** Handles POST /sms. Validates the body, calls `SmsClient.send`, maps the
 * result to an HTTP status, and emits an `edge.request.completed` audit on
 * every path. Validation failures use a distinct `InvalidRequest` error type
 * (NOT the sms-core `InvalidPhone` variant) so consumers can distinguish
 * shape errors from phone-format errors. */
export async function handleSms(req: SmsRouteRequest, deps: SmsRouteDeps): Promise<SmsRouteResponse> {
  const startedAt = Date.now()

  const validation = validateBody(req.body)
  if (!validation.ok) {
    const res = jsonResponse(400, { ok: false, error: { type: 'InvalidRequest', reason: validation.reason } })
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
    response = jsonResponse(status, { ok: false, error: wireSafeError(result.error) }, extra)
  }

  deps.audit.emitRequestCompleted({ status: response.status, durationMs: Date.now() - startedAt })
  return response
}
