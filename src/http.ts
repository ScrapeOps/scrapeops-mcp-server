import dotenv from 'dotenv';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
  type LegacyHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { loadHttpConfig, type HttpConfig } from './config.js';
import { MCP_CORS_ALLOW_HEADERS, clientAddress, isHttps, requestOrigin, sendEmpty, sendJson } from './http-utils.js';
import { logger } from './logger.js';
import { reportError } from './monitoring.js';
import { handleOAuthRequest, resolveAccessToken, type OAuthContext } from './oauth/routes.js';
import { wwwAuthenticate } from './oauth/metadata.js';
import { createScrapeOpsLogin, type ScrapeOpsLogin } from './oauth/scrapeops-login.js';
import { createOAuthStore } from './oauth/store.js';
import type { OAuthStore } from './oauth/types.js';
import { RATE_LIMITS, RateLimiter } from './rate-limit.js';
import { createScrapeOpsServer, sessionFromAuthInfo } from './server.js';

dotenv.config({ debug: false, quiet: true });

const DEFAULT_ALLOWED_ORIGINS = ['https://claude.ai', 'https://claude.com'];

export interface StartHttpOptions {
  config?: HttpConfig;
  store?: OAuthStore;
  login?: ScrapeOpsLogin;
  port?: number;
  host?: string;
  publicBaseUrl?: string;
  oauthEnabled?: boolean;
  requireOauth?: boolean;
  encryptionKey?: Buffer;
  envApiKey?: string | null;
}

export interface RunningHttpServer {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startHttpServer(options: StartHttpOptions = {}): Promise<RunningHttpServer> {
  const config = applyOptions(options.config ?? loadHttpConfig(), options);
  if (config.requireOauth && !config.oauthEnabled) {
    throw new Error('REQUIRE_OAUTH=true needs OAuth to be enabled');
  }
  if (config.oauthEnabled && !config.encryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required when OAuth is enabled');
  }
  if (config.oauthEnabled && process.env.NODE_ENV === 'production' && !config.publicBaseUrl && !options.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required when OAuth is enabled in production');
  }
  if (!Number.isInteger(config.port) || config.port < 0) {
    throw new Error('PORT must be a non-negative integer');
  }

  const onerror = (error: Error) => reportError(error, { path: '/mcp' });
  const factory: McpServerFactory = (ctx) => createScrapeOpsServer(sessionFromAuthInfo(ctx.authInfo));
  const mcp = createMcpHandler(factory, { legacy: 'reject', onerror });
  const legacy = legacyJsonHandler(factory, onerror);
  const mcpNode = toNodeHandler(
    {
      fetch: async (request, options) =>
        (await isLegacyRequest(request)) ? legacy(request, options) : mcp.fetch(request, options),
    },
    { onerror }
  );

  const store = config.oauthEnabled ? createOAuthStore({ dataDir: config.dataDir, store: options.store }) : undefined;
  const login = options.login ?? createScrapeOpsLogin(config.backendUrl);
  const rateLimiter = new RateLimiter();
  let baseUrl = config.publicBaseUrl || '';

  const oauthContext: OAuthContext | undefined =
    config.oauthEnabled && config.encryptionKey && store
      ? {
          config,
          baseUrl: () => baseUrl,
          store,
          encryptionKey: config.encryptionKey,
          login,
          rateLimiter,
        }
      : undefined;

  const server = http.createServer((req, res) => {
    void routeRequest(req, res, {
      config,
      baseUrl: () => baseUrl,
      oauth: oauthContext,
      rateLimiter,
      mcpNode,
    }).catch((error: unknown) => {
      reportError(error, { path: req.url });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error', error_description: 'Internal server error' });
      }
    });
  });

  const port = await listen(server, config.port, config.host);
  if (!baseUrl) baseUrl = `http://127.0.0.1:${port}`;

  logger.info('remote mcp listening', {
    port,
    baseUrl,
    oauth: config.oauthEnabled,
    requireOauth: config.requireOauth,
  });

  return {
    port,
    baseUrl,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await mcp.close();
      await closed;
    },
  };
}

interface RouteState {
  config: HttpConfig;
  baseUrl: () => string;
  oauth?: OAuthContext;
  rateLimiter: RateLimiter;
  mcpNode: NodeMcpRequestHandler;
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, state: RouteState): Promise<void> {
  const url = new URL(req.url || '/', state.baseUrl() || 'http://127.0.0.1');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && path === '/ready') {
    sendJson(res, 200, { status: 'ready' });
    return;
  }
  if (req.method === 'GET' && path === '/') {
    sendJson(res, 200, {
      name: 'ScrapeOps MCP',
      mcp_endpoint: '/mcp',
      health: '/health',
    });
    return;
  }

  if (process.env.NODE_ENV === 'production' && path !== '/health' && path !== '/ready' && !isHttps(req, state.config.trustProxy)) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'HTTPS is required' });
    return;
  }

  if (path !== '/health' && path !== '/ready' && !hostAllowed(req.headers.host, state.baseUrl())) {
    logger.warn('rejected host', { path, host: req.headers.host });
    sendJson(res, 403, { error: 'forbidden', error_description: 'Host is not allowed' });
    return;
  }

  if (state.oauth && (await handleOAuthRequest(req, res, state.oauth))) {
    return;
  }

  if (isRemovedSsePath(path)) {
    sendJson(res, 410, {
      error: 'endpoint_removed',
      error_description:
        'The HTTP+SSE transport (/sse, /messages) was removed in @scrapeops/mcp 2.0.0. Use Streamable HTTP at /mcp instead.',
      mcp_endpoint: '/mcp',
      docs: 'https://scrapeops.io/docs/mcp/overview/',
    });
    return;
  }

  if (!isMcpPath(path)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (!originAllowed(requestOrigin(req), state.baseUrl())) {
    logger.warn('rejected mcp origin', { path });
    sendJson(res, 403, { error: 'forbidden', error_description: 'Origin is not allowed' });
    return;
  }

  const origin = requestOrigin(req);
  res.setHeader('access-control-allow-origin', origin || '*');
  res.setHeader('access-control-expose-headers', 'www-authenticate');
  if (origin) res.setHeader('vary', 'origin');

  if (req.method === 'OPTIONS') {
    sendEmpty(res, 204, {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': MCP_CORS_ALLOW_HEADERS,
      'access-control-max-age': '600',
    });
    return;
  }

  const auth = await resolveAuth(req, state);
  if (!auth.ok) {
    logger.warn('mcp authentication failed', { path, reason: auth.error });
    unauthorized(res, state, auth.error === 'invalid' ? 'invalid_token' : undefined);
    return;
  }

  const limitKey = `mcp:${auth.accountId || clientAddress(req, state.config.trustProxy)}`;
  const limit = state.rateLimiter.take(limitKey, RATE_LIMITS.mcp);
  if (!limit.allowed) {
    sendJson(res, 429, { error: 'rate_limited', error_description: 'Too many requests' }, {
      'retry-after': String(limit.retryAfterSeconds),
    });
    return;
  }

  res.on('finish', () => {
    const fields = {
      path,
      status: res.statusCode,
      accountId: auth.accountId,
      authType: auth.authType,
    };
    if (res.statusCode >= 500) logger.error('mcp request failed', fields);
    else if (res.statusCode >= 400) logger.warn('mcp request rejected', fields);
    else logger.info('mcp request', fields);
  });
  await serveMcp(req, res, state, auth);
}

interface AuthSuccess {
  ok: true;
  apiKey: string;
  accountId?: string;
  clientId?: string;
  authType: 'oauth' | 'api_key';
}

async function resolveAuth(req: IncomingMessage, state: RouteState): Promise<AuthSuccess | { ok: false; error: 'missing' | 'invalid' }> {
  const authorization = header(req, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match || !state.oauth) return { ok: false, error: 'invalid' };
    const resolved = await resolveAccessToken(state.oauth.store, state.oauth.encryptionKey, match[1]);
    if (!resolved) return { ok: false, error: 'invalid' };
    return {
      ok: true,
      apiKey: resolved.apiKey,
      accountId: resolved.accountId,
      clientId: resolved.clientId,
      authType: 'oauth',
    };
  }

  if (state.config.requireOauth) return { ok: false, error: 'missing' };

  const headerKey = header(req, 'scrapeops-api-key') || header(req, 'scrapeops_api_key');
  if (headerKey) return { ok: true, apiKey: headerKey, authType: 'api_key' };
  if (state.config.envApiKey) return { ok: true, apiKey: state.config.envApiKey, authType: 'api_key' };
  return { ok: false, error: 'missing' };
}

async function serveMcp(req: IncomingMessage, res: ServerResponse, state: RouteState, auth: AuthSuccess): Promise<void> {
  const authInfo: AuthInfo = {
    token: auth.apiKey,
    clientId: auth.clientId ?? auth.authType,
    scopes: ['scrape'],
    extra: { accountId: auth.accountId, authType: auth.authType },
  };
  await state.mcpNode(Object.assign(req, { auth: authInfo }), res);
}

/**
 * Serves 2025-era requests statelessly with plain JSON bodies, matching the
 * 1.x `enableJsonResponse` behaviour instead of the SDK's SSE default.
 */
function legacyJsonHandler(
  factory: McpServerFactory,
  onerror: (error: Error) => void
): LegacyHttpHandler {
  return async (request, options) => {
    if (request.method !== 'POST') {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } },
        { status: 405, headers: { allow: 'POST, OPTIONS' } }
      );
    }
    const mcpServer = await factory({ era: 'legacy', authInfo: options?.authInfo, requestInfo: request });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcpServer.connect(transport);
      return await transport.handleRequest(request, { authInfo: options?.authInfo });
    } catch (error) {
      onerror(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      void mcpServer.close().catch((error) => {
        onerror(error instanceof Error ? error : new Error(String(error)));
      });
    }
  };
}

function unauthorized(res: ServerResponse, state: RouteState, error?: 'invalid_token'): void {
  const headers: Record<string, string> = {};
  if (state.oauth) headers['www-authenticate'] = wwwAuthenticate(state.baseUrl(), error);
  sendJson(
    res,
    401,
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: error === 'invalid_token' ? 'Invalid or expired token' : 'Unauthorized',
      },
    },
    headers
  );
}

function applyOptions(config: HttpConfig, options: StartHttpOptions): HttpConfig {
  return {
    ...config,
    port: options.port ?? config.port,
    host: options.host ?? config.host,
    publicBaseUrl: options.publicBaseUrl?.replace(/\/$/, '') ?? config.publicBaseUrl,
    oauthEnabled: options.oauthEnabled ?? config.oauthEnabled,
    requireOauth: options.requireOauth ?? config.requireOauth,
    encryptionKey: options.encryptionKey ?? config.encryptionKey,
    envApiKey: options.envApiKey === null ? undefined : options.envApiKey ?? config.envApiKey,
  };
}

function isMcpPath(path: string): boolean {
  return path === '/mcp';
}

/** Old HTTP+SSE transport paths removed in 2.0.0. */
function isRemovedSsePath(path: string): boolean {
  return path === '/sse' || path === '/messages' || path.startsWith('/messages/');
}

function hostAllowed(hostHeader: string | undefined, baseUrl: string): boolean {
  if (!hostHeader || !baseUrl) return false;
  let presented: URL;
  try {
    presented = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  const expected = new URL(baseUrl);
  if (presented.hostname !== expected.hostname) {
    const loopback = expected.hostname === '127.0.0.1' || expected.hostname === 'localhost';
    return loopback && (presented.hostname === '127.0.0.1' || presented.hostname === 'localhost');
  }
  if (!presented.port) return true;
  const expectedPort = expected.port || (expected.protocol === 'https:' ? '443' : '80');
  return presented.port === expectedPort;
}

function originAllowed(origin: string | undefined, baseUrl: string): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (baseUrl && url.origin === new URL(baseUrl).origin) return true;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  if (DEFAULT_ALLOWED_ORIGINS.includes(url.origin)) return true;
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return extra.includes(url.origin);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}
