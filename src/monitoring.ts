import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

/**
 * Reports an error to stderr and, when SENTRY_DSN is set, to Sentry.
 * Context must not include API keys, tokens, or passwords.
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message, { ...context, name: error instanceof Error ? error.name : 'Error' });

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  void sendToSentry(dsn, message, context).catch((sendError: unknown) => {
    logger.warn('sentry delivery failed', {
      message: sendError instanceof Error ? sendError.message : String(sendError),
    });
  });
}

async function sendToSentry(
  dsn: string,
  message: string,
  context: Record<string, unknown>
): Promise<void> {
  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const eventId = randomUUID().replace(/-/g, '');
  const envelopeHeader = JSON.stringify({ event_id: eventId, dsn });
  const itemHeader = JSON.stringify({ type: 'event' });
  const event = JSON.stringify({
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    message,
    extra: context,
    environment: process.env.NODE_ENV || 'development',
  });
  const body = `${envelopeHeader}\n${itemHeader}\n${event}`;

  await fetch(parsed.envelopeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=scrapeops-mcp/1.1.0`,
    },
    body,
  });
}

function parseDsn(dsn: string): { envelopeUrl: string; key: string } | null {
  try {
    const url = new URL(dsn);
    const key = decodeURIComponent(url.username);
    const projectId = url.pathname.replace(/^\//, '');
    if (!key || !projectId) return null;
    url.username = '';
    url.password = '';
    url.pathname = `/api/${projectId}/envelope/`;
    url.search = '';
    url.hash = '';
    return { envelopeUrl: url.toString(), key };
  } catch {
    return null;
  }
}
