import { SmsClient, MemoryRateLimiter } from '@itkujo/sms-core'
import { loadConfig } from './config.js'
import { openJsonStore } from './tenants/store.js'
import { createAuditLogger } from './audit/logger.js'
import { createSmsEdgeServer } from './server.js'

export const VERSION = '0.1.0'

async function main(): Promise<void> {
  const config = loadConfig()
  const store = await openJsonStore(config.tenantsPath)
  const audit = createAuditLogger()
  const rateLimiter = new MemoryRateLimiter()
  const client = new SmsClient({
    baseUrl: config.smsgate.baseUrl,
    username: config.smsgate.username,
    password: config.smsgate.password,
    timeoutMs: 15_000,
    rateLimiter,
    onAuditLog: (event) => audit.onAuditLog(event),
  })

  const server = createSmsEdgeServer({
    store,
    client,
    audit,
    adminPassword: config.adminPassword,
    version: VERSION,
  })

  // Read tenant count before starting to listen so the boot log line is
  // emitted before any request can possibly be accepted.
  const tenantCount = (await store.list()).length
  await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', resolve))
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'edge.boot.listening',
    port: config.port,
    version: VERSION,
    tenants: tenantCount,
  }))

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    // Re-entry guard: SIGTERM+SIGINT or double Ctrl-C can fire this twice.
    // Only the first invocation runs the close + timeout race.
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'edge.shutdown.start',
      signal,
    }))
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 10_000))
    try {
      await Promise.race([closed, timeout])
      process.exit(0)
    } catch (err) {
      // Distinguish the 10 s hard cap from a server.close error so log-based
      // ops debugging is not ambiguous.
      const message = err instanceof Error ? err.message : String(err)
      const event = message === 'shutdown timeout' ? 'edge.shutdown.timeout' : 'edge.shutdown.error'
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event,
        error: message,
      }))
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    event: 'edge.boot.fatal',
    error: err instanceof Error ? err.message : String(err),
  }))
  process.exit(1)
})
