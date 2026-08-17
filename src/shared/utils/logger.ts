/**
 * Tiny dependency-free logger with level filtering and consistent formatting.
 * Swapping in pino/winston later only means changing this file.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const

type Level = keyof typeof LEVELS
type EmitLevel = Exclude<Level, 'silent'>

const configuredLevel = (process.env.LOG_LEVEL ??
  (process.env.NODE_ENV === 'test' ? 'silent' : 'debug')) as Level

const threshold: number = LEVELS[configuredLevel] ?? LEVELS.debug

const LABELS: Record<EmitLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
}

function emit(level: EmitLevel, args: unknown[]): void {
  if (LEVELS[level] < threshold) return

  const prefix = `[${new Date().toISOString()}] ${LABELS[level]}`
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log

  write(prefix, ...args)
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export const logger: Logger = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
}

export default logger
