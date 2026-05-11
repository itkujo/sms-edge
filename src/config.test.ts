import { describe, it, expect } from 'vitest'
import { loadConfig, type Config } from './config.js'

const minimalEnv = {
  ADMIN_PASSWORD: 'a'.repeat(16),
  SMSGATE_USER: 'user',
  SMSGATE_PASS: 'pass',
  SMSGATE_BASE_URL: 'https://sms.relentnet.dev',
}

describe('loadConfig', () => {
  it('returns a fully-populated Config when all required vars present', () => {
    const cfg: Config = loadConfig(minimalEnv)
    expect(cfg.adminPassword).toBe('a'.repeat(16))
    expect(cfg.smsgate.username).toBe('user')
    expect(cfg.smsgate.password).toBe('pass')
    expect(cfg.smsgate.baseUrl).toBe('https://sms.relentnet.dev')
    expect(cfg.port).toBe(3000)
    expect(cfg.tenantsPath).toBe('/data/tenants.json')
    expect(cfg.logLevel).toBe('info')
  })

  it('respects PORT override when valid', () => {
    expect(loadConfig({ ...minimalEnv, PORT: '8080' }).port).toBe(8080)
  })

  it('respects TENANTS_PATH override', () => {
    expect(loadConfig({ ...minimalEnv, TENANTS_PATH: './data/x.json' }).tenantsPath).toBe('./data/x.json')
  })

  it.each(['info', 'warn', 'error'] as const)('accepts LOG_LEVEL=%s', (level) => {
    expect(loadConfig({ ...minimalEnv, LOG_LEVEL: level }).logLevel).toBe(level)
  })

  it.each([
    ['ADMIN_PASSWORD missing', { ...minimalEnv, ADMIN_PASSWORD: undefined }, /ADMIN_PASSWORD/],
    ['ADMIN_PASSWORD too short', { ...minimalEnv, ADMIN_PASSWORD: 'short' }, /at least 16 characters/],
    ['SMSGATE_USER missing', { ...minimalEnv, SMSGATE_USER: undefined }, /SMSGATE_USER/],
    ['SMSGATE_PASS missing', { ...minimalEnv, SMSGATE_PASS: undefined }, /SMSGATE_PASS/],
    ['SMSGATE_BASE_URL missing', { ...minimalEnv, SMSGATE_BASE_URL: undefined }, /SMSGATE_BASE_URL/],
    ['PORT non-numeric', { ...minimalEnv, PORT: 'eighty' }, /PORT/],
    ['PORT out of range', { ...minimalEnv, PORT: '99999' }, /PORT/],
    ['LOG_LEVEL invalid', { ...minimalEnv, LOG_LEVEL: 'debug' }, /LOG_LEVEL/],
  ])('throws on %s (exactly one problem reported)', (_label, env, pattern) => {
    let caught: Error | undefined
    try {
      loadConfig(env as NodeJS.ProcessEnv)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(pattern)
    // Each single-var failure should produce exactly one bullet in the aggregated error.
    const bullets = caught!.message.match(/\n  - /g) ?? []
    expect(bullets).toHaveLength(1)
  })

  it('aggregates exactly the missing-var problems when env is empty (no spurious extras)', () => {
    let caught: Error | undefined
    try {
      loadConfig({})
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/ADMIN_PASSWORD.*SMSGATE_USER.*SMSGATE_PASS.*SMSGATE_BASE_URL/s)
    // Empty env: ADMIN_PASSWORD + SMSGATE_USER + SMSGATE_PASS + SMSGATE_BASE_URL = 4 bullets.
    // PORT is undefined (skipped) and LOG_LEVEL defaults to 'info' (valid), so neither contributes.
    const bullets = caught!.message.match(/\n  - /g) ?? []
    expect(bullets).toHaveLength(4)
  })
})
