import { promisify } from 'node:util'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

const PARAMS = { N: 16384, r: 8, p: 1 } as const
const SALT_BYTES = 16
const KEY_BYTES = 64
const ALGO = 'scrypt'
const PARAM_STRING = `N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}`

/**
 * Hashes a token with scrypt (N=16384, r=8, p=1) and a fresh 16-byte salt.
 * Returns a self-describing hash string of the form:
 *   scrypt$N=16384,r=8,p=1$<base64-salt>$<base64-derived-key>
 *
 * Cost: ~100ms per call on modern hardware. Do not call in tight loops;
 * use a verify-cache layer if the upstream lookup hot-path needs faster
 * verifies (see TenantStore).
 */
export async function hashToken(token: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(token, salt, KEY_BYTES, PARAMS)
  return `${ALGO}$${PARAM_STRING}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * Constant-time verifies a token against a stored hash. Returns false
 * (never throws) on any malformed input.
 *
 * Strict params check: rejects any stored hash whose embedded params do
 * not match the current PARAM_STRING exactly. This means a future N/r/p
 * upgrade forces token re-issuance; there is no auto-upgrade path.
 *
 * Cost: ~100ms per matching call (one scrypt op). Early returns on
 * malformed input are effectively free; callers iterating over a tenant
 * list pay roughly N * 100ms in the worst case.
 */
export async function verifyToken(token: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const [algo, params, saltB64, keyB64] = parts
  if (algo !== ALGO) return false
  if (params !== PARAM_STRING) return false
  if (!saltB64 || !keyB64) return false

  // Note: Buffer.from(s, 'base64') silently skips non-alphabet chars rather
  // than throwing -- the post-decode length check below is the real validator.
  const salt = Buffer.from(saltB64, 'base64')
  const expectedKey = Buffer.from(keyB64, 'base64')
  if (salt.length !== SALT_BYTES || expectedKey.length !== KEY_BYTES) return false

  const actualKey = await scrypt(token, salt, KEY_BYTES, PARAMS)
  return timingSafeEqual(actualKey, expectedKey)
}
