export type LogLevel = 'info' | 'warn' | 'error'

export interface Config {
  port: number
  adminPassword: string
  smsgate: {
    baseUrl: string
    username: string
    password: string
  }
  tenantsPath: string
  logLevel: LogLevel
}

const MIN_ADMIN_PASSWORD_LENGTH = 16
const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set(['info', 'warn', 'error'])

function isLogLevel(value: string): value is LogLevel {
  return (VALID_LOG_LEVELS as ReadonlySet<string>).has(value)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []

  const adminPassword = env['ADMIN_PASSWORD']
  if (!adminPassword) {
    problems.push('ADMIN_PASSWORD is required')
  } else if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    problems.push(`ADMIN_PASSWORD must be at least 16 characters (got ${adminPassword.length})`)
  }

  const smsgateUser = env['SMSGATE_USER']
  if (!smsgateUser) problems.push('SMSGATE_USER is required')

  const smsgatePass = env['SMSGATE_PASS']
  if (!smsgatePass) problems.push('SMSGATE_PASS is required')

  const smsgateBaseUrl = env['SMSGATE_BASE_URL']
  if (!smsgateBaseUrl) problems.push('SMSGATE_BASE_URL is required')

  let port = 3000
  const portRaw = env['PORT']
  if (portRaw !== undefined) {
    const parsed = Number(portRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`PORT must be an integer 1-65535 (got '${portRaw}')`)
    } else {
      port = parsed
    }
  }

  const logLevelRaw = env['LOG_LEVEL'] ?? 'info'
  if (!isLogLevel(logLevelRaw)) {
    problems.push(`LOG_LEVEL must be one of: info, warn, error (got '${logLevelRaw}')`)
  }

  if (problems.length > 0) {
    throw new Error(`sms-edge config errors:\n  - ${problems.join('\n  - ')}`)
  }

  // Re-narrow after the throw guard: every required var is defined here.
  // The isLogLevel guard above narrowed logLevelRaw, but TS doesn't carry
  // the narrowing past the throw boundary, so we re-check.
  if (!isLogLevel(logLevelRaw)) {
    throw new Error('unreachable: logLevel validated above')
  }

  return {
    port,
    adminPassword: adminPassword!,
    smsgate: {
      baseUrl: smsgateBaseUrl!,
      username: smsgateUser!,
      password: smsgatePass!,
    },
    tenantsPath: env['TENANTS_PATH'] ?? '/data/tenants.json',
    logLevel: logLevelRaw,
  }
}
