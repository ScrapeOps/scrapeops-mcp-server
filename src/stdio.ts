import { createScrapeOpsServer } from './server.js';

export async function startStdioServer(): Promise<void> {
  const server = createScrapeOpsServer({ mode: 'stdio' });
  await server.start({ transportType: 'stdio' });
}
