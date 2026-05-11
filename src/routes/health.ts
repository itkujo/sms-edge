import type { TenantStore } from '../tenants/store.js'

export interface HealthBody {
  ok: true
  version: string
  tenants: number
  uptimeSec: number
}

export interface RenderHealthArgs {
  store: TenantStore
  startedAtMs: number
  version: string
}

export async function renderHealth(args: RenderHealthArgs): Promise<HealthBody> {
  const tenants = (await args.store.list()).length
  const uptimeSec = Math.floor((Date.now() - args.startedAtMs) / 1000)
  return { ok: true, version: args.version, tenants, uptimeSec }
}
