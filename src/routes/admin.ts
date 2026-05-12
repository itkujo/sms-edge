import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashToken } from '../tenants/hash.js'
import type { Tenant, TenantStore } from '../tenants/store.js'

/** Dependencies for the admin route. */
export interface AdminRouteDeps {
  store: TenantStore
  adminPassword: string
}

/** Input shape for `handleAdmin`. Body is the decoded UTF-8 form body, or
 * null for GET requests. Headers are passed in as-received from the HTTP
 * layer (case preserved); lookup is case-insensitive. Caller (Task 9) MUST
 * cap body size before passing it here -- this module does not enforce a limit. */
export interface AdminRouteRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
}

/** Output shape: status, headers (case preserved for emission), serialized body. */
export interface AdminRouteResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const DELETE_PATH_RE = /^\/admin\/tenants\/([^/]+)\/delete$/

/** Routes admin requests after a basic-auth gate. Every successful request
 * gets a CSRF token derived from the auth header; POSTs must echo it back
 * in a hidden form field. HTML is server-rendered with inline CSS, no JS
 * framework, no client-side state. */
export async function handleAdmin(req: AdminRouteRequest, deps: AdminRouteDeps): Promise<AdminRouteResponse> {
  const authHeader = headerCI(req.headers, 'authorization')
  if (!authHeader) return authChallenge()
  const credentialsValid = checkBasicAuth(authHeader, 'admin', deps.adminPassword)
  if (!credentialsValid) return authChallenge()

  const csrfToken = computeCsrf(deps.adminPassword, authHeader)

  if (req.method === 'GET' && req.path === '/admin') {
    return { status: 302, headers: { Location: '/admin/tenants' }, body: '' }
  }
  if (req.method === 'GET' && req.path === '/admin/tenants') {
    const tenants = await deps.store.list()
    return htmlResponse(200, renderTenantsPage(tenants, csrfToken))
  }
  if (req.method === 'POST' && req.path === '/admin/tenants') {
    return await postCreate(req, deps, authHeader)
  }
  const deleteMatch = req.method === 'POST' && DELETE_PATH_RE.exec(req.path)
  if (deleteMatch) {
    return await postDelete(req, deps, authHeader, decodeURIComponent(deleteMatch[1]!))
  }
  if (req.path.startsWith('/admin')) {
    return htmlResponse(404, `<h1>Not found</h1><p>No admin route at <code>${escapeHtml(req.path)}</code>.</p>`)
  }
  return htmlResponse(404, '<h1>Not found</h1>')
}

function headerCI(headers: Record<string, string>, key: string): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === key.toLowerCase()) return headers[k]
  }
  return undefined
}

function authChallenge(): AdminRouteResponse {
  return {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="sms-edge admin"', 'Content-Type': 'text/html; charset=utf-8' },
    body: '<h1>Authentication required</h1>',
  }
}

function checkBasicAuth(headerValue: string, expectedUser: string, expectedPass: string): boolean {
  if (!headerValue.startsWith('Basic ')) return false
  const decoded = Buffer.from(headerValue.slice('Basic '.length), 'base64').toString('utf8')
  const idx = decoded.indexOf(':')
  if (idx === -1) return false
  const user = decoded.slice(0, idx)
  const pass = decoded.slice(idx + 1)
  // Constant-time compare both halves. Pad to equal length first.
  const userOk = bufEqual(Buffer.from(user, 'utf8'), Buffer.from(expectedUser, 'utf8'))
  const passOk = bufEqual(Buffer.from(pass, 'utf8'), Buffer.from(expectedPass, 'utf8'))
  return userOk && passOk
}

function bufEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Still do a constant-time compare on a padded buffer to avoid leaking length.
    const max = Math.max(a.length, b.length)
    const ap = Buffer.alloc(max)
    const bp = Buffer.alloc(max)
    a.copy(ap)
    b.copy(bp)
    timingSafeEqual(ap, bp)
    return false
  }
  return timingSafeEqual(a, b)
}

function computeCsrf(adminPassword: string, sessionFingerprint: string): string {
  return createHmac('sha256', adminPassword).update(sessionFingerprint).digest('hex')
}

function verifyCsrf(adminPassword: string, sessionFingerprint: string, presented: string | undefined): boolean {
  if (!presented) return false
  const expected = computeCsrf(adminPassword, sessionFingerprint)
  if (presented.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'))
}

function parseForm(body: string | null): Record<string, string> {
  if (!body) return {}
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '))
    const val = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
    out[key] = val
  }
  return out
}

async function postCreate(req: AdminRouteRequest, deps: AdminRouteDeps, authHeader: string): Promise<AdminRouteResponse> {
  const fields = parseForm(req.body)
  if (!verifyCsrf(deps.adminPassword, authHeader, fields['csrf'])) {
    return htmlResponse(403, '<h1>CSRF check failed</h1>')
  }
  const name = (fields['name'] ?? '').trim()
  const validation = validateTenantName(name)
  if (!validation.ok) {
    return htmlResponse(400, `<h1>Invalid name</h1><p>${escapeHtml(validation.reason)}</p>`)
  }
  // Pre-check is a UX optimization; the store is the source of truth (race-safe).
  const existing = await deps.store.list()
  if (existing.some((t) => t.name === name)) {
    return htmlResponse(400, `<h1>Conflict</h1><p>tenant '${escapeHtml(name)}' already exists.</p>`)
  }
  const plaintextToken = randomBytes(32).toString('base64url')
  const hash = await hashToken(plaintextToken)
  try {
    await deps.store.add(name, hash)
  } catch (err) {
    // Concurrent create raced us; surface the same 400 we would have on a clean duplicate.
    if (err instanceof Error && /already exists/.test(err.message)) {
      return htmlResponse(400, `<h1>Conflict</h1><p>tenant '${escapeHtml(name)}' already exists.</p>`)
    }
    throw err
  }
  return htmlResponse(200, renderCreatedPage(name, plaintextToken))
}

async function postDelete(req: AdminRouteRequest, deps: AdminRouteDeps, authHeader: string, name: string): Promise<AdminRouteResponse> {
  const fields = parseForm(req.body)
  if (!verifyCsrf(deps.adminPassword, authHeader, fields['csrf'])) {
    return htmlResponse(403, '<h1>CSRF check failed</h1>')
  }
  const removed = await deps.store.remove(name)
  if (!removed) return htmlResponse(404, `<h1>Not found</h1><p>tenant '${escapeHtml(name)}' does not exist.</p>`)
  return { status: 302, headers: { Location: '/admin/tenants' }, body: '' }
}

function validateTenantName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: 'name is required' }
  if (name !== name.toLowerCase()) return { ok: false, reason: 'name must be lowercase' }
  if (name.length < 2) return { ok: false, reason: 'name must be at least 2 characters' }
  if (name.length > 32) return { ok: false, reason: 'name must be at most 32 characters' }
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name has invalid characters (use a-z, 0-9, hyphens; cannot start with hyphen)' }
  return { ok: true }
}

function htmlResponse(status: number, body: string): AdminRouteResponse {
  return {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
    body: layout(body),
  }
}

function layout(inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sms-edge admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    code, .token { font-family: ui-monospace, monospace; word-break: break-all; }
    .token { background: #f4f4f4; padding: 0.5rem; display: block; margin: 0.5rem 0; }
    form { display: inline; }
    button { cursor: pointer; }
    .warn { background: #fff8c5; padding: 0.5rem 1rem; border: 1px solid #d4a72c; }
  </style>
</head>
<body>
${inner}
</body>
</html>`
}

function renderTenantsPage(tenants: readonly Readonly<Tenant>[], csrfToken: string): string {
  const rows = tenants.length === 0
    ? '<tr><td colspan="3"><em>No tenants configured.</em></td></tr>'
    : tenants.map((t) => `
      <tr>
        <td><code>${escapeHtml(t.name)}</code></td>
        <td>${escapeHtml(t.createdAt)}</td>
        <td>
          <form method="POST" action="/admin/tenants/${encodeURIComponent(t.name)}/delete">
            <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit" onclick="return confirm('Delete tenant ${escapeHtml(t.name)}?')">delete</button>
          </form>
        </td>
      </tr>`).join('')

  return `<h1>Tenants</h1>
<table>
  <thead><tr><th>Name</th><th>Created (UTC)</th><th>Action</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>Add tenant</h2>
<form method="POST" action="/admin/tenants">
  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
  <label>Name: <input name="name" required pattern="[a-z0-9][a-z0-9-]{1,31}"></label>
  <button type="submit">Create</button>
</form>`
}

function renderCreatedPage(name: string, plaintextToken: string): string {
  return `<h1>Tenant '${escapeHtml(name)}' created</h1>
<div class="warn">
  <strong>Save this token now.</strong> It is not stored in plaintext and cannot be retrieved later. If you lose it, delete the tenant and create a new one.
</div>
<p>Token:</p>
<code class="token">${escapeHtml(plaintextToken)}</code>
<p>This token works with any of the routes below. Pick the one your client expects:</p>
<p><strong>1. Native (<code>POST /sms</code>)</strong> &mdash; either header works:</p>
<code class="token">X-Auth: ${escapeHtml(plaintextToken)}</code>
<code class="token">Authorization: Bearer ${escapeHtml(plaintextToken)}</code>
<p><strong>2. Logto's <em>GatewayAPI SMS</em> connector (<code>POST /gatewayapi/rest/mtsms</code>)</strong> &mdash; paste this exact value into the connector's <em>API Token</em> field:</p>
<code class="token">${escapeHtml(plaintextToken)}</code>
<p>...with <em>Endpoint</em> set to <code>https://&lt;your-sms-edge-host&gt;/gatewayapi/rest/mtsms</code>. The <em>Sender</em> field is required by the Logto form but is ignored by sms-edge (SMSGate sends from the enrolled phone's number).</p>
<p><a href="/admin/tenants">Back to tenants</a></p>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
