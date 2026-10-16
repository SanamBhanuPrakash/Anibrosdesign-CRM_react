/**
 * Structured JSON logger with recursive, substring-based redaction.
 * One line per event on stdout/stderr (12-factor); shipped by the platform (Loki/CloudWatch/…), never stored in-app.
 */
const SENSITIVE_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'api-key',
  'signature',
  'credential',
  'private_key',
  'otp',
  'recovery_code',
  'session',
  'csrf',
  'set-cookie',
];

const MAX_DEPTH = 6;
const MAX_STRING = 2_000;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_FRAGMENTS.some((f) => k.includes(f));
}

export function redactSensitiveData(value: unknown, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSensitiveData(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactSensitiveData(v, depth + 1);
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const env = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
  return ORDER[env] ?? ORDER.info;
}

export class Logger {
  constructor(
    private correlationId?: string,
    private bindings: Record<string, unknown> = {}
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.correlationId, { ...this.bindings, ...bindings });
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    if (ORDER[level] < minLevel()) return;
    // Silence info/debug noise under test, but keep warn/error visible.
    if (process.env.NODE_ENV === 'test' && ORDER[level] < ORDER.warn && !process.env.TEST_LOG) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      message,
      ...(Object.keys(this.bindings).length ? { ...redactSensitiveData(this.bindings) } : {}),
      ...(meta ? { meta: redactSensitiveData(meta) } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>) {
    this.log('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>) {
    this.log('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>) {
    this.log('error', message, meta);
  }
}

export const logger = new Logger();
