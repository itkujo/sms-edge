/**
 * Transport-level error discriminants for sms-edge.
 *
 * These are deliberately distinct from sms-core's `SmsError` union (which
 * describes phone-format / rate-limit / provider failures). The transport
 * vocabulary describes HTTP-layer concerns: malformed bodies, missing auth,
 * unknown routes, size limits, and internal-server faults.
 *
 * Consumers doing error-type dispatch can switch on `type` and trust that
 * `InvalidRequest` always means "request body shape was wrong", never
 * "the phone number was invalid".
 */
export type TransportErrorType =
  | 'InvalidRequest'
  | 'Unauthorized'
  | 'NotFound'
  | 'PayloadTooLarge'
  | 'InternalError'

export interface TransportError {
  type: TransportErrorType
  reason: string
}

/** Wire envelope for a transport-level failure response. */
export interface TransportErrorBody {
  ok: false
  error: TransportError
}

/** Builds a wire envelope. Used by the HTTP server and route handlers. */
export function transportError(type: TransportErrorType, reason: string): TransportErrorBody {
  return { ok: false, error: { type, reason } }
}
