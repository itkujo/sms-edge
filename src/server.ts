import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { SmsClient } from '@itkujo/sms-core'
import { handleSms } from './routes/sms.js'
import { handleAdmin } from './routes/admin.js'
import { renderHealth } from './routes/health.js'
import { type AuditLogger, withRequestContext } from './audit/logger.js'
import type { TenantStore } from './tenants/store.js'
import { transportError } from './errors.js'

/** Dependencies for the HTTP server. Composition root (Task 10) constructs
 * these; tests inject fakes. */
export interface ServerDeps {
  store: TenantStore
  client: SmsClient
  audit: AuditLogger
  adminPassword: string
  version: string
}

const MAX_BODY_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const HEADERS_TIMEOUT_MS = 10_000

/** Creates an http.Server wired to the route handlers from Tasks 6-8.
 *
 * Behavior:
 *  - 16 KB body limit; returns 413 PayloadTooLarge on excess.
 *  - 30s request timeout, 10s headers timeout.
 *  - GET /health is unauthenticated.
 *  - /admin/* uses HTTP Basic auth (delegated to handleAdmin).
 *  - POST /sms uses an X-Auth tenant token (resolved via store.findByToken).
 *  - Bridge-level audit events (`edge.request.received`/`completed`) fire
 *    only on /sms paths; admin and health are not tenant-routed and emit
 *    their own audit events (none in v0.1).
 *  - When the peer IP cannot be determined (destroyed socket), peerIp is
 *    set to the literal string 'unknown' rather than rejecting the request.
 *    Rate-limiter buckets will treat all such requests as one peer.
 *  - On any thrown error from the handler chain, returns 500 InternalError
 *    if headers have not been sent; logs to stderr (the audit logger is the
 *    happy path; stderr is the last resort).
 */
export function createSmsEdgeServer(deps: ServerDeps): Server {
  const startedAtMs = Date.now()

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, deps, startedAtMs).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(transportError('InternalError', 'internal server error')))
        } else {
          res.end()
        }
      } catch {
        // best-effort cleanup
      }
      // Last-resort log: the audit logger is normally how we record errors,
      // but if the audit emit itself failed (or the handler threw before
      // emitting received), stderr is the floor.
      // eslint-disable-next-line no-console
      console.error('unhandled error in request handler', err)
    })
  })

  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  startedAtMs: number,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0]!
  const headers = normalizeHeaders(req.headers)

  // GET /health is unauthenticated and cheap.
  if (method === 'GET' && path === '/health') {
    const body = await renderHealth({ store: deps.store, startedAtMs, version: deps.version })
    writeJson(res, 200, body)
    return
  }

  // /admin/* uses basic auth, not X-Auth tenant tokens.
  if (path === '/admin' || path.startsWith('/admin/')) {
    const adminBody = await readBody(req, res)
    if (adminBody === undefined) return // 413 already written
    const adminRes = await handleAdmin({
      method, path, headers, body: adminBody,
    }, { store: deps.store, adminPassword: deps.adminPassword })
    writeResponse(res, adminRes.status, adminRes.headers, adminRes.body)
    return
  }

  // POST /sms uses a tenant token, accepted in either header:
  //   - `X-Auth: <token>` (sms-edge native convention)
  //   - `Authorization: Bearer <token>` (Logto's connector-http-sms convention)
  //   - `Authorization: <token>` (bare, for clients that don't add a scheme)
  // X-Auth wins if both are present.
  if (method === 'POST' && path === '/sms') {
    const presentedToken = extractTenantToken(headers)
    if (!presentedToken) {
      writeJson(res, 401, transportError('Unauthorized', 'missing X-Auth or Authorization header'))
      return
    }
    const tenant = await deps.store.findByToken(presentedToken)
    if (!tenant) {
      writeJson(res, 401, transportError('Unauthorized', 'invalid X-Auth token'))
      return
    }

    const reqId = 'req_' + randomBytes(8).toString('hex')
    const peerIp = req.socket.remoteAddress ?? 'unknown'

    await withRequestContext({ tenant: tenant.name, reqId }, async () => {
      const t0 = Date.now()
      const raw = await readBody(req, res)
      if (raw === undefined) return // 413 already written

      let body: unknown = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        deps.audit.emitRequestReceived({ method, path })
        writeJson(res, 400, transportError('InvalidRequest', 'body is not valid JSON'))
        deps.audit.emitRequestCompleted({ status: 400, durationMs: Date.now() - t0 })
        return
      }

      const obj = body as Record<string, unknown> | null
      const inputTo = typeof obj?.['to'] === 'string' ? (obj['to'] as string) : undefined
      const inputType = typeof obj?.['type'] === 'string' ? (obj['type'] as string) : undefined
      deps.audit.emitRequestReceived({
        method, path,
        ...(inputTo !== undefined && { to: inputTo }),
        ...(inputType !== undefined && { type: inputType }),
      })

      const routeRes = await handleSms({ body, peerIp }, { client: deps.client, audit: deps.audit })
      writeResponse(res, routeRes.status, routeRes.headers, routeRes.body)
    })
    return
  }

  writeJson(res, 404, transportError('NotFound', 'no route'))
}

function normalizeHeaders(input: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Extracts the presented tenant token from either:
 *   - `X-Auth: <token>` (sms-edge native), or
 *   - `Authorization: Bearer <token>` / `Authorization: <token>` (Logto's
 *     connector-http-sms hard-codes `Authorization`, with the value being
 *     whatever the operator typed into the connector config).
 * X-Auth takes precedence. Headers are pre-lowercased by `normalizeHeaders`. */
function extractTenantToken(headers: Record<string, string>): string | undefined {
  const xAuth = headers['x-auth']
  if (xAuth) return xAuth
  const authz = headers['authorization']
  if (!authz) return undefined
  // Match `Bearer <token>` case-insensitively; otherwise treat the whole value as the token.
  const bearer = /^Bearer\s+(.+)$/i.exec(authz)
  return bearer ? bearer[1]!.trim() : authz.trim()
}

/** Streams the request body into a string with a 16 KB cap.
 *
 * Resolves with the body string on success, the empty string on socket
 * error (treated as "no body" downstream), or `undefined` when the limit
 * was exceeded -- in which case this function has already written a 413
 * response, so the caller must just `return` without writing anything else.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let abandoned = false
    req.on('data', (chunk: Buffer) => {
      if (abandoned) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        abandoned = true
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(transportError('PayloadTooLarge', 'body exceeds 16 KB')))
        }
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!abandoned) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      if (!abandoned) resolve('')
    })
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeResponse(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers)
  res.end(body)
}
