import type { SmsClient, SendInput, SendResult, SmsError } from '@itkujo/sms-core'
import type { AuditLogger } from '../audit/logger.js'
import { transportError } from '../errors.js'

/** Dependencies for the GatewayAPI-compatible SMS handler. */
export interface GatewayApiRouteDeps {
  client: SmsClient
  audit: AuditLogger
}

/** Input shape for `handleGatewayApi`. `peerIp` is supplied by the HTTP
 * layer and used for ip-based rate limiting -- the GatewayAPI envelope has
 * no caller-IP field. */
export interface GatewayApiRouteRequest {
  body: unknown
  peerIp: string
}

export interface GatewayApiRouteResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0
}

interface ParsedBody {
  msisdn: string
  message: string
}

function validateBody(body: unknown): { ok: true; parsed: ParsedBody } | { ok: false; reason: string } {
  if (!isObject(body)) return { ok: false, reason: 'body must be a JSON object' }
  if (!isNonEmptyString(body['message'])) return { ok: false, reason: 'field "message" must be a non-empty string' }
  const recipients = body['recipients']
  if (!Array.isArray(recipients)) return { ok: false, reason: 'field "recipients" must be an array' }
  if (recipients.length === 0) return { ok: false, reason: 'field "recipients" must contain at least one entry' }
  // sms-core sends one message per call; we enforce single-recipient here so
  // rate-limit accounting and audit logging stay per-call accurate.
  if (recipients.length > 1) return { ok: false, reason: 'only a single recipient is supported per request' }
  const first = recipients[0]
  if (!isObject(first)) return { ok: false, reason: 'each recipient must be an object with an msisdn field' }
  if (!isNonEmptyString(first['msisdn'])) return { ok: false, reason: 'recipient msisdn must be a non-empty string' }
  return { ok: true, parsed: { msisdn: first['msisdn'], message: body['message'] } }
}

/** Maps a sms-core `SmsError` to an HTTP status. Mirrors the mapping used by
 * the `/sms` route (`statusForError` in `routes/sms.ts`); kept local to keep
 * the two handlers independently evolvable. */
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
      const _exhaustive: never = err
      void _exhaustive
      return 500
    }
  }
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): GatewayApiRouteResponse {
  let serialized: string
  try {
    serialized = JSON.stringify(body)
  } catch {
    serialized = JSON.stringify({ ok: false, error: { type: 'Network', reason: 'response body could not be serialized' } })
  }
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: serialized,
  }
}

function wireSafeError(err: SmsError): Record<string, unknown> {
  if (err.type === 'Network') {
    return { type: 'Network', reason: String(err.cause) }
  }
  return { ...err }
}

/** Generate a numeric id for the GatewayAPI success response. GatewayAPI's
 * own API returns 64-bit signed message ids. We don't have a stable numeric
 * counter, so we synthesize one from the current ms timestamp -- Logto only
 * cares about the 2xx status and that the response parses as JSON. */
function syntheticId(): number {
  return Date.now()
}

/** Handles `POST /gatewayapi/rest/mtsms`. Translates GatewayAPI's wire shape
 *
 *   { sender, message, recipients: [{ msisdn }] }
 *
 * into a `SendInput` with `type: 'Generic'` so sms-core's default renderer
 * passes the pre-rendered message straight through to SMSGate. The `sender`
 * field is accepted but ignored: SMSGate sends from the enrolled Android
 * phone's number and there is no "sender id" concept in that path.
 *
 * Returns a GatewayAPI-shaped success body (`{ ids: [<num>], usage }`) so
 * any future GatewayAPI client beyond Logto can parse it; on error returns
 * the sms-edge canonical `{ ok: false, error: { type, ... } }` shape used
 * by the `/sms` route, since Logto v1.22 only checks the status code. */
export async function handleGatewayApi(
  req: GatewayApiRouteRequest,
  deps: GatewayApiRouteDeps,
): Promise<GatewayApiRouteResponse> {
  const startedAt = Date.now()

  const validation = validateBody(req.body)
  if (!validation.ok) {
    const res = jsonResponse(400, transportError('InvalidRequest', validation.reason))
    deps.audit.emitRequestCompleted({ status: res.status, durationMs: Date.now() - startedAt })
    return res
  }

  const input: SendInput = {
    to: validation.parsed.msisdn,
    type: 'Generic',
    payload: { text: validation.parsed.message },
    ip: req.peerIp,
  }

  const result: SendResult = await deps.client.send(input)

  let response: GatewayApiRouteResponse
  if (result.ok) {
    response = jsonResponse(200, {
      ids: [syntheticId()],
      usage: { total_cost: 0, currency: 'USD', countries: {} },
    })
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
