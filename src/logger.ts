const SECRET_KEY = /api[_-]?key|authorization|password|token|secret|verifier|cookie/i;

export function redactValue(value: string): string {
  return value.replace(/([?&]api_key=)[^&\s"']+/gi, '$1[redacted]');
}

export function redactFields(
  fields: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      redacted[key] = '[redacted]';
    } else if (typeof value === 'string') {
      redacted[key] = redactValue(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...redactFields(fields),
  };
  if (process.env.LOG_FORMAT === 'json') {
    console.error(JSON.stringify(entry));
    return;
  }
  const extra = fields ? ` ${JSON.stringify(redactFields(fields))}` : '';
  console.error(`[${level.toUpperCase()}] ${entry.time} ${message}${extra}`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
