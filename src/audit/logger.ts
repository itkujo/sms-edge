import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditEvent } from '@itkujo/sms-core'

type Level = 'info' | 'warn' | 'error'

export interface RequestContext {
  tenant: string
  reqId: string
}

export interface RequestReceivedFields {
  method: string
  path: string
  to?: string
  type?: string
}

export interface RequestCompletedFields {
  status: number
  durationMs: number
}

export interface AuditLogger {
  /** Callback to hand to sms-core's SmsClient via the onAuditLog config field. */
  onAuditLog(event: AuditEvent): void
  /** Emitted at the start of request processing (after auth, before sms-core). */
  emitRequestReceived(fields: RequestReceivedFields): void
  /** Emitted right before writing the response. */
  emitRequestCompleted(fields: RequestCompletedFields): void
}

interface LoggerOptions {
  /** Default writes to process.stdout; tests inject a fake. */
  write?: (line: string) => void
}

const ctxStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Runs `fn` with the given request context attached to the AsyncLocalStorage.
 * Every emit performed inside `fn` (or any async work scheduled before `fn`
 * resolves) will pick up `tenant` and `reqId`. Returns whatever `fn` returns.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return ctxStorage.run(ctx, fn)
}

/**
 * Creates an AuditLogger that writes one-line JSON to stdout. Pass `opts.write`
 * to capture lines in tests. The returned `onAuditLog` method is safe to pass
 * as a bare reference (e.g. `new SmsClient({ onAuditLog: logger.onAuditLog })`)
 * -- it does not use `this`.
 */
export function createAuditLogger(opts: LoggerOptions = {}): AuditLogger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'))

  function emit(level: Level, fields: Record<string, unknown>): void {
    const ctx = ctxStorage.getStore()
    const base: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ...(ctx && { tenant: ctx.tenant, reqId: ctx.reqId }),
    }
    // Never let a logging failure surface to the caller; a broken stdout
    // shouldn't crash an in-flight request or fail an SMS send.
    try {
      write(JSON.stringify({ ...base, ...fields }))
    } catch {
      // Intentionally swallowed.
    }
  }

  return {
    onAuditLog(event) {
      const level = levelForCoreEvent(event)
      emit(level, { ...event })
    },
    emitRequestReceived(fields) {
      emit('info', { event: 'edge.request.received', ...fields })
    },
    emitRequestCompleted(fields) {
      const level: Level = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info'
      emit(level, { event: 'edge.request.completed', ...fields })
    },
  }
}

function levelForCoreEvent(event: AuditEvent): Level {
  switch (event.kind) {
    case 'send.attempt':
    case 'send.success':
      return 'info'
    case 'send.blocked':
      return 'warn'
    case 'send.failure':
      return 'error'
    default: {
      // Exhaustiveness guard: if sms-core adds a new AuditEvent kind, this
      // line fails to compile, forcing an explicit decision here.
      const _exhaustive: never = event
      void _exhaustive
      return 'info'
    }
  }
}
