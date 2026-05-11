import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createSmsEdgeServer } from '../../src/server.js'
import { openJsonStore } from '../../src/tenants/store.js'
import { createAuditLogger } from '../../src/audit/logger.js'
import type { SmsClient } from '@itkujo/sms-core'

const ADMIN_PASSWORD = 'super-long-test-admin-password'

let dir: string
let url: string
let close: () => Promise<void>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sms-edge-e2e-'))
  const store = await openJsonStore(join(dir, 'tenants.json'))
  const audit = createAuditLogger({ write: () => {} })
  const client: SmsClient = {
    send: async () => ({ ok: true, messageId: 'real-msg', deviceId: 'real-dev', state: 'Pending' }),
    getStatus: async () => ({ ok: false, error: { type: 'Network', cause: new Error() } }),
  } as unknown as SmsClient
  const server = createSmsEdgeServer({ store, client, audit, adminPassword: ADMIN_PASSWORD, version: '0.1.0' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise<void>((resolve) => server.close(() => resolve()))
})
afterEach(async () => {
  await close()
  await rm(dir, { recursive: true, force: true })
})

const authHeader = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')

describe('e2e: full admin + sms flow', () => {
  it('create tenant -> POST /sms with the new token -> 200', async () => {
    // Step 1: GET the admin list page to obtain a CSRF token.
    const listRes = await fetch(`${url}/admin/tenants`, { headers: { authorization: authHeader } })
    expect(listRes.status).toBe(200)
    const listBody = await listRes.text()
    const csrfMatch = listBody.match(/name="csrf" value="([^"]+)"/)
    expect(csrfMatch).toBeTruthy()
    const csrf = csrfMatch![1]!

    // Step 2: POST to create tenant 'acme'.
    const createRes = await fetch(`${url}/admin/tenants`, {
      method: 'POST',
      headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=acme&csrf=${encodeURIComponent(csrf)}`,
    })
    expect(createRes.status).toBe(200)
    const createBody = await createRes.text()
    const tokenMatch = createBody.match(/<code class="token">([^<]+)<\/code>/)
    expect(tokenMatch).toBeTruthy()
    const token = tokenMatch![1]!

    // Step 3: POST /sms with the new token; expect 200.
    const sendRes = await fetch(`${url}/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': token },
      body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '654321' } }),
    })
    expect(sendRes.status).toBe(200)
    const sendBody = await sendRes.json()
    expect(sendBody).toEqual({ ok: true, messageId: 'real-msg', deviceId: 'real-dev', state: 'Pending' })
  })

  it('create -> delete -> token no longer works', async () => {
    const listRes = await fetch(`${url}/admin/tenants`, { headers: { authorization: authHeader } })
    const csrf = (await listRes.text()).match(/name="csrf" value="([^"]+)"/)![1]!

    const createRes = await fetch(`${url}/admin/tenants`, {
      method: 'POST',
      headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=acme&csrf=${encodeURIComponent(csrf)}`,
    })
    const token = (await createRes.text()).match(/<code class="token">([^<]+)<\/code>/)![1]!

    // Need a fresh CSRF for the delete (same session fingerprint, same token).
    const delRes = await fetch(`${url}/admin/tenants/acme/delete`, {
      method: 'POST',
      headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(csrf)}`,
      redirect: 'manual',
    })
    expect(delRes.status).toBe(302)

    const sendRes = await fetch(`${url}/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': token },
      body: JSON.stringify({ to: '+12125551234', type: 'SignIn', payload: { code: '1' } }),
    })
    expect(sendRes.status).toBe(401)
  })
})
