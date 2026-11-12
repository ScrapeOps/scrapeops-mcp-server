#!/usr/bin/env node
import dotenv from 'dotenv';

dotenv.config({ debug: false, quiet: true });

const transport = process.env.MCP_TRANSPORT;
const port = process.env.PORT;

if (transport === 'http' || port) {
  const { startHttpServer } = await import('./http.js');
  await startHttpServer();
} else {
  const { startStdioServer } = await import('./stdio.js');
  await startStdioServer();
}
