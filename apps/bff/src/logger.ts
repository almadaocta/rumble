/**
 * Minimal levelled logger for the server runtime.
 *
 * Everything in the request path logs through here rather than `console.*`, so
 * there is one place to set the level, silence output under test, and add
 * redaction or a real transport. Small enough not to need a logging framework
 * for a single-user local app.
 *
 * One-shot CLI scripts under `src/scripts/` deliberately use `console` —
 * printing to the terminal *is* their job, and routing that through a levelled
 * logger would only hide it.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Tests assert on behaviour, not console noise, so they default to silent —
 * an explicit LOG_LEVEL still wins when you're debugging a failing test.
 */
function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && isLogLevel(raw)) return raw;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return 'silent';
  return 'info';
}

let activeLevel: LogLevel = resolveLevel();

/** Override the threshold at runtime. Returns the previous level so callers can restore it. */
export function setLogLevel(level: LogLevel): LogLevel {
  const previous = activeLevel;
  activeLevel = level;
  return previous;
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

const SECRET_KEY_PATTERN = /(secret|token|password|api[-_]?key|authorization|refresh)/i;
const REDACTED = '[redacted]';

/**
 * Strips credential-shaped values before they reach a log line. Matches on key
 * name rather than value shape, so it stays useful when a token doesn't look
 * like one. Depth-limited because log payloads are for humans, not archives.
 */
export function redact(value: unknown, depth = 4): unknown {
  if (depth <= 0) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth - 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        SECRET_KEY_PATTERN.test(k) ? [k, REDACTED] : [k, redact(v, depth - 1)],
      ),
    );
  }
  return value;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const WRITERS: Record<Exclude<LogLevel, 'silent'>, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

function format(scope: string, message: string, context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return `[${scope}] ${message}`;
  return `[${scope}] ${message} ${JSON.stringify(redact(context))}`;
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  scope: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (RANK[level] < RANK[activeLevel]) return;
  WRITERS[level](format(scope, message, context));
}

/** Creates a logger that tags every line with `[scope]`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => emit('debug', scope, message, context),
    info: (message, context) => emit('info', scope, message, context),
    warn: (message, context) => emit('warn', scope, message, context),
    error: (message, context) => emit('error', scope, message, context),
  };
}

/**
 * Normalises a thrown value into something loggable. Errors lose their message
 * entirely under `JSON.stringify`, which is how "{}" ends up in logs.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { error: String(error) };
}
