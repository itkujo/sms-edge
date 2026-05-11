import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { SmsClient } from '@itkujo/sms-core'
import { handleSms } from './routes/sms.js'
import { handleAdmin } from './routes/admin.js'
import { renderHealth } from './routes/health.js'
import { type AuditLogger, withRequestContext } from './audit/logger.js'
import type { TenantStore } from './tenants/store.js'

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

export function createSmsEdgeServer(deps: ServerDeps): Server {
  const startedAtMs = Date.now()

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, deps, startedAtMs).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { type: 'Config', reason: 'internal server error' } }))
        } else {
          res.end()
        }
      } catch {
        // best-effort cleanup
      }
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

  // POST /sms uses X-Auth tenant token.
  if (method === 'POST' && path === '/sms') {
    const presentedToken = headers['x-auth']
    if (!presentedToken) {
      writeJson(res, 401, { ok: false, error: { type: 'Config', reason: 'missing X-Auth header' } })
      return
    }
    const tenant = await deps.store.findByToken(presentedToken)
    if (!tenant) {
      writeJson(res, 401, { ok: false, error: { type: 'Config', reason: 'invalid X-Auth token' } })
      return
    }

    const reqId = 'req_' + randomBytes(8).toString('hex')
    const peerIp = req.socket.remoteAddress ?? 'unknown'

    await withRequestContext({ tenant: tenant.name, reqId }, async () => {
      const raw = await readBody(req, res)
      if (raw === undefined) return // 413 already written

      let body: unknown = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        deps.audit.emitRequestReceived({ method, path })
        writeJson(res, 400, { ok: false, error: { type: 'InvalidPhone', reason: 'body is not valid JSON' } })
        deps.audit.emitRequestCompleted({ status: 400, durationMs: 0 })
        return
      }

      const inputTo = typeof (body as Record<string, unknown> | null)?.['to'] === 'string'
        ? (body as Record<string, unknown>)['to'] as string
        : undefined
      const inputType = typeof (body as Record<string, unknown> | null)?.['type'] === 'string'
        ? (body as Record<string, unknown>)['type'] as string
        : undefined
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

  writeJson(res, 404, { ok: false, error: { type: 'Config', reason: 'no route' } })
}

function normalizeHeaders(input: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

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
          res.end(JSON.stringify({ ok: false, error: { type: 'Config', reason: 'body exceeds 16 KB' } }))
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
