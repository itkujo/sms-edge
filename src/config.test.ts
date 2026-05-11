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
  ])('throws on %s', (_label, env, pattern) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(pattern)
  })

  it('error messages name every problem in one throw', () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_PASSWORD.*SMSGATE_USER.*SMSGATE_PASS.*SMSGATE_BASE_URL/s)
  })
})
