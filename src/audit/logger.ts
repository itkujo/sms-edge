import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditEvent } from '@itkujo/sms-core'

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

export async function withRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return ctxStorage.run(ctx, fn)
}

export function createAuditLogger(opts: LoggerOptions = {}): AuditLogger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'))

  function emit(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void {
    const ctx = ctxStorage.getStore()
    const base: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ...(ctx?.tenant !== undefined && { tenant: ctx.tenant }),
      ...(ctx?.reqId !== undefined && { reqId: ctx.reqId }),
    }
    write(JSON.stringify({ ...base, ...fields }))
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
      const level = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info'
      emit(level, { event: 'edge.request.completed', ...fields })
    },
  }
}

function levelForCoreEvent(event: AuditEvent): 'info' | 'warn' | 'error' {
  switch (event.kind) {
    case 'send.attempt':
    case 'send.success':
      return 'info'
    case 'send.blocked':
      return 'warn'
    case 'send.failure':
      return 'error'
  }
}
