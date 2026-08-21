import { redact } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** Injection point for tests and for shipping to an OTLP collector. */
  sink?: (line: Record<string, unknown>) => void
  base?: Record<string, unknown>
}

function defaultSink(line: Record<string, unknown>): void {
  const stream = line.level === 'error' || line.level === 'warn' ? process.stderr : process.stdout
  stream.write(JSON.stringify(line) + '\n')
}

/**
 * Structured JSON logs, one object per line, with every field passed through
 * secret redaction. Trace correlation is carried as ordinary fields
 * (`trace_id`, `job_id`, `provider`) so an OpenTelemetry collector can lift
 * them without the app taking an OTel dependency at this stage.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info'
  const sink = opts.sink ?? defaultSink
  const base = opts.base ?? {}
  const threshold = LEVEL_ORDER[level] ?? 20

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < threshold) return
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...(fields ?? {}),
    }
    if (payload.err instanceof Error) {
      const err = payload.err as Error & { kind?: string; code?: string }
      payload.err = { name: err.name, message: err.message, kind: err.kind, code: err.code, stack: err.stack }
    }
    sink(redact(payload))
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  }
}

/** Discards everything. Used by unit tests that assert on behaviour, not output. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} })
