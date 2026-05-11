import type { TenantStore } from '../tenants/store.js'

/** Response body for `GET /health`. The `ok` field is a literal `true` so
 * consumers can narrow without checking a boolean. Errors propagate to the
 * HTTP handler as thrown exceptions (mapped to 500), not as `ok: false`. */
export interface HealthBody {
  ok: true
  version: string
  tenants: number
  uptimeSec: number
}

/** Inputs for the renderer. `startedAtMs` is a Unix-ms timestamp from
 * `Date.now()`, NOT a monotonic process timer. */
export interface RenderHealthArgs {
  store: TenantStore
  startedAtMs: number
  version: string
}

/** Pure renderer: counts tenants and computes uptime. Used by the HTTP
 * `GET /health` handler and (formatted) by the Dockerfile healthcheck. */
export async function renderHealth(args: RenderHealthArgs): Promise<HealthBody> {
  const tenants = (await args.store.list()).length
  // Clamp at 0 in case the system clock moved backwards (NTP step, manual
  // adjustment) or the caller passed a future startedAtMs by mistake.
  const uptimeSec = Math.max(0, Math.floor((Date.now() - args.startedAtMs) / 1000))
  return { ok: true, version: args.version, tenants, uptimeSec }
}
