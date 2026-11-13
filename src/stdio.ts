import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { reportError } from './monitoring.js';
import { createScrapeOpsServer, envSession } from './server.js';

export function startStdioServer(): void {
  serveStdio(() => createScrapeOpsServer(envSession()), {
    onerror: (error) => reportError(error, { path: 'stdio' }),
  });
}
