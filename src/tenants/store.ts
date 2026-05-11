import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { verifyToken } from './hash.js'

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface Tenant {
  name: string
  tokenHash: string
  createdAt: string // ISO-8601 UTC
}

export interface TenantStore {
  /** Returns a snapshot of all tenants. Mutating individual entries is a type error. */
  list(): Promise<readonly Readonly<Tenant>[]>
  /** Adds a tenant. Throws if `name` already exists. Persists to disk before committing in memory. */
  add(name: string, tokenHash: string): Promise<void>
  /** Removes a tenant by name. Returns true if it existed, false otherwise. Invalidates cache entries. */
  remove(name: string): Promise<boolean>
  /** Iterates ALL tenants for timing-safety. Caches by SHA256(token) for 5 minutes. */
  findByToken(presentedToken: string): Promise<Tenant | null>
}

interface FileShape {
  version: 1
  tenants: Tenant[]
}

const FILE_VERSION = 1

/**
 * Opens (or initializes) a JSON-file-backed tenant store at `filePath`.
 * Validates the file shape and refuses to start on corruption.
 */
export async function openJsonStore(filePath: string): Promise<TenantStore> {
  await mkdir(dirname(filePath), { recursive: true })
  const initial = await loadOrInit(filePath)
  return new JsonStore(filePath, initial)
}

async function loadOrInit(filePath: string): Promise<FileShape> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const empty: FileShape = { version: FILE_VERSION, tenants: [] }
      await atomicWrite(filePath, JSON.stringify(empty, null, 2))
      return empty
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`tenants store at ${filePath} failed to parse: ${(err as Error).message}`)
  }

  if (!isObject(parsed)) throw new Error(`tenants store at ${filePath} is not a JSON object`)
  if (parsed['version'] !== FILE_VERSION) {
    throw new Error(`tenants store at ${filePath} has unknown version (got ${String(parsed['version'])}, want ${FILE_VERSION})`)
  }
  const tenantsRaw = parsed['tenants']
  if (!Array.isArray(tenantsRaw)) {
    throw new Error(`tenants store at ${filePath}: tenants field must be an array`)
  }

  const tenants: Tenant[] = []
  const seen = new Set<string>()
  for (let i = 0; i < tenantsRaw.length; i++) {
    const t = tenantsRaw[i]
    if (!isObject(t)) throw new Error(`tenants[${i}] is not an object`)
    const name = t['name']
    const tokenHash = t['tokenHash']
    const createdAt = t['createdAt']
    if (typeof name !== 'string' || !name) throw new Error(`tenants[${i}].name must be a non-empty string`)
    if (typeof tokenHash !== 'string' || !tokenHash) throw new Error(`tenants[${i}].tokenHash must be a non-empty string`)
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`tenants[${i}].createdAt must be a parseable ISO-8601 string`)
    }
    if (seen.has(name)) throw new Error(`tenants store has duplicate tenant name: ${name}`)
    seen.add(name)
    tenants.push({ name, tokenHash, createdAt })
  }

  return { version: FILE_VERSION, tenants }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

class JsonStore implements TenantStore {
  private writeLock: Promise<unknown> = Promise.resolve()
  // Cache key is SHA256(token) -- not the token itself, so a memory dump can't leak Logto secrets.
  private tokenCache = new Map<string, { tenantName: string; expiresAt: number }>()

  constructor(
    private readonly filePath: string,
    private state: FileShape,
  ) {}

  async list(): Promise<readonly Readonly<Tenant>[]> {
    return [...this.state.tenants]
  }

  async add(name: string, tokenHash: string): Promise<void> {
    return this.serializeWrite(async () => {
      if (this.state.tenants.some((t) => t.name === name)) {
        throw new Error(`tenant '${name}' already exists`)
      }
      // Build the next state in a local, write to disk, THEN commit in memory.
      // If atomicWrite throws, in-memory state still matches disk.
      const next: FileShape = {
        version: FILE_VERSION,
        tenants: [
          ...this.state.tenants,
          { name, tokenHash, createdAt: new Date().toISOString() },
        ],
      }
      await atomicWrite(this.filePath, JSON.stringify(next, null, 2))
      this.state = next
    })
  }

  async remove(name: string): Promise<boolean> {
    return this.serializeWrite(async () => {
      const nextTenants = this.state.tenants.filter((t) => t.name !== name)
      const removed = nextTenants.length !== this.state.tenants.length
      if (!removed) return false
      // Same write-then-commit ordering as `add`.
      const next: FileShape = { version: FILE_VERSION, tenants: nextTenants }
      await atomicWrite(this.filePath, JSON.stringify(next, null, 2))
      this.state = next
      // Invalidate cache entries for this tenant.
      for (const [key, val] of this.tokenCache) {
        if (val.tenantName === name) this.tokenCache.delete(key)
      }
      return true
    })
  }

  async findByToken(presentedToken: string): Promise<Tenant | null> {
    const cacheKey = createHash('sha256').update(presentedToken).digest('hex')
    const now = Date.now()
    this.evictExpired(now)

    const cached = this.tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      const tenant = this.state.tenants.find((t) => t.name === cached.tenantName)
      if (tenant) return tenant
      // Tenant was removed since the cache entry was set -- evict and fall through.
      this.tokenCache.delete(cacheKey)
    }

    // Iterate ALL tenants regardless of early match to avoid timing leaks.
    let matched: Tenant | null = null
    for (const tenant of this.state.tenants) {
      const ok = await verifyToken(presentedToken, tenant.tokenHash)
      if (ok && matched === null) matched = tenant
    }
    if (matched) {
      this.tokenCache.set(cacheKey, { tenantName: matched.name, expiresAt: now + TOKEN_CACHE_TTL_MS })
    }
    return matched
  }

  private evictExpired(now: number): void {
    for (const [key, val] of this.tokenCache) {
      if (val.expiresAt <= now) this.tokenCache.delete(key)
    }
  }

  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn, fn)
    this.writeLock = next.catch(() => {})
    return next
  }
}
