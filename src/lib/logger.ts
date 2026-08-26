/**
 * Logging for an MCP server.
 *
 * stdout is the JSON-RPC protocol channel - writing anything to it corrupts the
 * transport and the client disconnects. Everything therefore goes to stderr.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const threshold =
  ORDER[(process.env.TUTORIAL_MCP_LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info

function emit(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return
  const line = `[tutorial-mcp] ${level.toUpperCase()} ${message}`
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${format(extra)}\n`)
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit('debug', message, extra),
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
}
