import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpConfig } from '../config.js';
import {
  clientAddress,
  contentType,
  HttpError,
  parseFormBody,
  readBody,
  readCookie,
  redirect,
  sendHtml,
  sendJson,
} from '../http-utils.js';
import { logger } from '../logger.js';
import { RATE_LIMITS, RateLimiter } from '../rate-limit.js';
import { decryptString, encryptString, isAllowedRedirectUri, randomToken, redirectUriMatches, safeEqual, sha256, verifyPkce } from './crypto.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { consentPage, loginPage, messagePage, revokePage, type AuthorizeForm } from './pages.js';
import type { ScrapeOpsLogin } from './scrapeops-login.js';
import { LoginError } from './scrapeops-login.js';
import type { OAuthStore, ResolvedAccessToken } from './types.js';

const PENDING_COOKIE = 'so_oauth_req';
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface OAuthContext {
  config: HttpConfig;
  baseUrl: () => string;
  store: OAuthStore;
  encryptionKey: Buffer;
  login: ScrapeOpsLogin;
  rateLimiter: RateLimiter;
}

export async function resolveAccessToken(
  store: OAuthStore,
  encryptionKey: Buffer,
  token: string
): Promise<ResolvedAccessToken | null> {
  const record = await store.getToken(sha256(token));
  if (!record || record.kind !== 'access' || record.revoked || record.expiresAt <= Date.now()) {
    return null;
  }
  if (!record.scope.split(/\s+/).includes('scrape')) return null;
  return {
    accountId: record.accountId,
    apiKey: decryptString(record.apiKeyCiphertext, encryptionKey),
    clientId: record.clientId,
    scope: record.scope,
  };
}

export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<boolean> {
  const url = new URL(req.url || '/', ctx.baseUrl());
  const path = url.pathname;
  const oauthPaths = new Set([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/authorize',
    '/authorize/login',
    '/authorize/decision',
    '/token',
    '/register',
    '/revoke',
    '/oauth/revoke-access',
  ]);
  if (!oauthPaths.has(path)) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  try {
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, protectedResourceMetadata(ctx.baseUrl()), corsHeaders());
      return true;
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, authorizationServerMetadata(ctx.baseUrl()), corsHeaders());
      return true;
    }
    if (path === '/register') {
      await handleRegister(req, res, ctx);
      return true;
    }
    if (path === '/token') {
      await handleToken(req, res, ctx);
      return true;
    }
    if (path === '/revoke') {
      await handleRevoke(req, res, ctx);
      return true;
    }
    if (path === '/authorize' && req.method === 'GET') {
      await handleAuthorizeGet(req, url, res, ctx);
      return true;
    }
    if (path === '/authorize/login' && req.method === 'POST') {
      await handleLogin(req, res, ctx);
      return true;
    }
    if (path === '/authorize/decision' && req.method === 'POST') {
      await handleDecision(req, res, ctx);
      return true;
    }
    if (path === '/oauth/revoke-access' && req.method === 'GET') {
      sendHtml(res, 200, revokePage());
      return true;
    }
    if (path === '/oauth/revoke-access' && req.method === 'POST') {
      await handleUserRevoke(req, res, ctx);
      return true;
    }
    methodNotAllowed(res, 'GET, POST');
    return true;
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: 'invalid_request', error_description: error.message }, corsHeaders());
      return true;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'Malformed JSON' }, corsHeaders());
      return true;
    }
    throw error;
  }
}

async function handleAuthorizeGet(req: IncomingMessage, url: URL, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (!allow(ctx, res, req, 'authorize')) return;
  const form = formFromParams(url.searchParams);
  const invalid = await validateAuthorizeForm(ctx, form);
  if (invalid) {
    await denyAuthorize(ctx, res, form, invalid.error, invalid.description);
    return;
  }
  sendHtml(res, 200, loginPage(form));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (!allow(ctx, res, req, 'login')) return;
  const params = await readParams(req);
  const form = formFromParams(params);
  const invalid = await validateAuthorizeForm(ctx, form);
  if (invalid) {
    await denyAuthorize(ctx, res, form, invalid.error, invalid.description);
    return;
  }

  const email = params.get('email')?.trim() || '';
  const password = params.get('password') || '';
  if (!email || !password) {
    sendHtml(res, 400, loginPage(form, 'Email and password are required.'));
    return;
  }

  let accounts;
  try {
    accounts = await ctx.login(email, password);
  } catch (error) {
    const message = error instanceof LoginError ? error.message : 'ScrapeOps login failed.';
    logger.warn('oauth login failed', { path: '/authorize/login' });
    sendHtml(res, 401, loginPage(form, message));
    return;
  }

  const client = await ctx.store.getClient(form.clientId);
  const pendingId = randomToken();
  await ctx.store.savePending({
    id: pendingId,
    clientId: form.clientId,
    redirectUri: form.redirectUri,
    codeChallenge: form.codeChallenge,
    state: form.state,
    scope: form.scope,
    resource: form.resource || undefined,
    userEmail: email,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      apiKeyCiphertext: encryptString(account.apiKey, ctx.encryptionKey),
    })),
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  sendHtml(res, 200, consentPage({
    pendingId,
    clientName: client?.clientName || 'MCP client',
    email,
    accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
  }), {
    'set-cookie': pendingCookie(pendingId, ctx.baseUrl().startsWith('https://')),
  });
}

async function handleDecision(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (!allow(ctx, res, req, 'authorize')) return;
  const params = await readParams(req);
  const pendingId = params.get('pending_id') || '';
  const cookie = readCookie(req, PENDING_COOKIE);
  const pending = pendingId ? await ctx.store.getPending(pendingId) : null;
  if (!pending || !cookie || !safeEqual(cookie, pendingId)) {
    sendHtml(res, 400, messagePage('Session expired', 'The sign-in session expired. Start the connection again from your MCP client.'));
    return;
  }

  const decision = params.get('decision');
  if (decision !== 'approve') {
    await ctx.store.deletePending(pending.id);
    redirect(res, callbackUrl(pending.redirectUri, { error: 'access_denied', state: pending.state, error_description: 'The user denied the request.' }));
    return;
  }

  const account = pending.accounts.find((item) => item.id === params.get('account_id'));
  if (!account) {
    sendHtml(res, 400, messagePage('Account required', 'Choose a ScrapeOps account to continue.'));
    return;
  }

  const code = randomToken();
  await ctx.store.saveAuthCode({
    codeHash: sha256(code),
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    state: pending.state,
    scope: pending.scope,
    resource: pending.resource,
    accountId: account.id,
    apiKeyCiphertext: account.apiKeyCiphertext,
    expiresAt: Date.now() + ctx.config.authCodeTtlSeconds * 1000,
  });
  await ctx.store.deletePending(pending.id);
  logger.info('oauth authorization approved', { accountId: account.id, clientId: pending.clientId });
  res.setHeader('set-cookie', `${PENDING_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  redirect(res, callbackUrl(pending.redirectUri, { code, state: pending.state }));
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }
  if (!allow(ctx, res, req, 'token')) return;
  const params = await readParams(req);
  const client = await authenticateClient(ctx, req, params);
  if (!client) {
    sendJson(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed.' }, {
      ...corsHeaders(),
      'www-authenticate': 'Basic realm="scrapeops"',
    });
    return;
  }

  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    await exchangeCode(ctx, res, client.clientId, params);
    return;
  }
  if (grantType === 'refresh_token') {
    await refreshTokens(ctx, res, client.clientId, params);
    return;
  }
  sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'Unsupported grant_type.' }, corsHeaders());
}

async function exchangeCode(ctx: OAuthContext, res: ServerResponse, clientId: string, params: URLSearchParams): Promise<void> {
  const code = params.get('code') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const verifier = params.get('code_verifier') || '';
  const record = code ? await ctx.store.consumeAuthCode(sha256(code)) : null;
  if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri || !verifyPkce(verifier, record.codeChallenge)) {
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' }, corsHeaders());
    return;
  }
  const resource = params.get('resource');
  if (resource && resource !== (record.resource || `${ctx.baseUrl()}/mcp`)) {
    sendJson(res, 400, { error: 'invalid_target', error_description: 'Resource does not match the authorization request.' }, corsHeaders());
    return;
  }
  await sendTokenResponse(ctx, res, {
    clientId,
    accountId: record.accountId,
    apiKeyCiphertext: record.apiKeyCiphertext,
    scope: record.scope,
  });
}

async function refreshTokens(ctx: OAuthContext, res: ServerResponse, clientId: string, params: URLSearchParams): Promise<void> {
  const refreshToken = params.get('refresh_token') || '';
  const record = refreshToken ? await ctx.store.getToken(sha256(refreshToken)) : null;
  if (!record || record.kind !== 'refresh' || record.clientId !== clientId) {
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is invalid.' }, corsHeaders());
    return;
  }
  if (record.revoked || record.expiresAt <= Date.now()) {
    await ctx.store.revokeFamily(record.familyId);
    logger.warn('oauth refresh token reuse or expiry', { accountId: record.accountId, clientId });
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is no longer valid.' }, corsHeaders());
    return;
  }
  await ctx.store.revokeToken(record.tokenHash);
  await sendTokenResponse(ctx, res, {
    clientId,
    accountId: record.accountId,
    apiKeyCiphertext: record.apiKeyCiphertext,
    scope: record.scope,
    familyId: record.familyId,
  });
}

async function sendTokenResponse(
  ctx: OAuthContext,
  res: ServerResponse,
  issued: { clientId: string; accountId: string; apiKeyCiphertext: string; scope: string; familyId?: string }
): Promise<void> {
  const familyId = issued.familyId || randomToken(16);
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const now = Date.now();
  await ctx.store.saveToken({
    tokenHash: sha256(accessToken),
    kind: 'access',
    familyId,
    clientId: issued.clientId,
    accountId: issued.accountId,
    apiKeyCiphertext: issued.apiKeyCiphertext,
    scope: issued.scope,
    expiresAt: now + ctx.config.accessTokenTtlSeconds * 1000,
    revoked: false,
  });
  await ctx.store.saveToken({
    tokenHash: sha256(refreshToken),
    kind: 'refresh',
    familyId,
    clientId: issued.clientId,
    accountId: issued.accountId,
    apiKeyCiphertext: issued.apiKeyCiphertext,
    scope: issued.scope,
    expiresAt: now + ctx.config.refreshTokenTtlSeconds * 1000,
    revoked: false,
  });
  logger.info('oauth token issued', { accountId: issued.accountId, clientId: issued.clientId });
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ctx.config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: issued.scope,
  }, corsHeaders());
}

async function handleRegister(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }
  if (!allow(ctx, res, req, 'register')) return;
  const body = await readBody(req);
  const parsed = body ? JSON.parse(body) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'Expected a JSON object.' }, corsHeaders());
    return;
  }
  const metadata = parsed as {
    client_name?: unknown;
    redirect_uris?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
    token_endpoint_auth_method?: unknown;
  };
  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
  if (redirectUris.length === 0 || redirectUris.length > 10 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https or loopback http URLs.' }, corsHeaders());
    return;
  }
  const responseTypes = Array.isArray(metadata.response_types) ? metadata.response_types : ['code'];
  if (!responseTypes.every((type) => type === 'code')) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'Only the code response type is supported.' }, corsHeaders());
    return;
  }
  const grantTypes = Array.isArray(metadata.grant_types) ? metadata.grant_types : ['authorization_code', 'refresh_token'];
  if (!grantTypes.every((grant) => grant === 'authorization_code' || grant === 'refresh_token')) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'Unsupported grant type.' }, corsHeaders());
    return;
  }
  const authMethod = typeof metadata.token_endpoint_auth_method === 'string' ? metadata.token_endpoint_auth_method : 'none';
  if (authMethod !== 'none' && authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post') {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'Unsupported token endpoint auth method.' }, corsHeaders());
    return;
  }

  const clientSecret = authMethod === 'none' ? undefined : randomToken();
  const clientId = randomToken();
  const clientName = typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 200) : 'MCP client';
  await ctx.store.saveClient({
    clientId,
    clientSecretHash: clientSecret ? sha256(clientSecret) : undefined,
    clientName,
    redirectUris,
    tokenEndpointAuthMethod: authMethod,
    createdAt: Math.floor(Date.now() / 1000),
  });
  logger.info('oauth client registered', { clientId, authMethod });
  sendJson(res, 201, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
  }, corsHeaders());
}

async function handleRevoke(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }
  if (!allow(ctx, res, req, 'revoke')) return;
  const params = await readParams(req);
  const client = await authenticateClient(ctx, req, params);
  const token = params.get('token') || '';
  if (client && token) {
    const record = await ctx.store.getToken(sha256(token));
    if (record && record.clientId === client.clientId) {
      await ctx.store.revokeFamily(record.familyId);
      logger.info('oauth token family revoked', { accountId: record.accountId, clientId: client.clientId });
    }
  }
  sendJson(res, 200, {}, corsHeaders());
}

async function handleUserRevoke(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  if (!allow(ctx, res, req, 'login')) return;
  const params = await readParams(req);
  const email = params.get('email')?.trim() || '';
  const password = params.get('password') || '';
  if (!email || !password) {
    sendHtml(res, 400, revokePage('Email and password are required.'));
    return;
  }
  try {
    const accounts = await ctx.login(email, password);
    let revoked = 0;
    for (const account of accounts) {
      revoked += await ctx.store.revokeByAccount(account.id);
    }
    logger.info('oauth account access revoked', { accounts: accounts.length, tokens: revoked });
    sendHtml(res, 200, messagePage('Access revoked', 'MCP clients can no longer use this ScrapeOps account until you connect again.'));
  } catch (error) {
    const message = error instanceof LoginError ? error.message : 'ScrapeOps login failed.';
    logger.warn('oauth revoke login failed');
    sendHtml(res, 401, revokePage(message));
  }
}

async function authenticateClient(ctx: OAuthContext, req: IncomingMessage, params: URLSearchParams) {
  const basic = basicCredentials(req);
  const clientId = basic?.id || params.get('client_id') || '';
  const clientSecret = basic?.secret || params.get('client_secret') || '';
  const client = clientId ? await ctx.store.getClient(clientId) : null;
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === 'none') return client;
  if (!client.clientSecretHash || !clientSecret || !safeEqual(sha256(clientSecret), client.clientSecretHash)) return null;
  return client;
}

async function validateAuthorizeForm(ctx: OAuthContext, form: AuthorizeForm): Promise<{ error: string; description: string } | null> {
  if (form.responseType !== 'code') return { error: 'unsupported_response_type', description: 'Only response_type=code is supported.' };
  if (form.codeChallengeMethod !== 'S256' || !form.codeChallenge) {
    return { error: 'invalid_request', description: 'PKCE S256 code_challenge is required.' };
  }
  if (!form.state) return { error: 'invalid_request', description: 'state is required.' };
  if (form.scope !== 'scrape') return { error: 'invalid_scope', description: 'The scrape scope is required.' };
  if (form.resource && form.resource !== `${ctx.baseUrl()}/mcp`) {
    return { error: 'invalid_target', description: 'resource does not match this MCP server.' };
  }
  const client = await ctx.store.getClient(form.clientId);
  if (!client) return { error: 'invalid_client', description: 'Unknown client_id.' };
  if (!redirectUriMatches(client.redirectUris, form.redirectUri)) {
    return { error: 'invalid_request', description: 'redirect_uri is not registered for this client.' };
  }
  return null;
}

async function denyAuthorize(
  ctx: OAuthContext,
  res: ServerResponse,
  form: AuthorizeForm,
  error: string,
  description: string
): Promise<void> {
  const client = form.clientId ? await ctx.store.getClient(form.clientId) : null;
  if (client && form.redirectUri && redirectUriMatches(client.redirectUris, form.redirectUri)) {
    const query: Record<string, string> = { error, error_description: description };
    if (form.state) query.state = form.state;
    redirect(res, callbackUrl(form.redirectUri, query));
    return;
  }
  sendHtml(res, 400, messagePage('Authorization error', description));
}

function formFromParams(params: URLSearchParams): AuthorizeForm {
  const scope = params.get('scope')?.trim() || 'scrape';
  return {
    clientId: params.get('client_id') || '',
    redirectUri: params.get('redirect_uri') || '',
    codeChallenge: params.get('code_challenge') || '',
    codeChallengeMethod: params.get('code_challenge_method') || '',
    state: params.get('state') || '',
    scope,
    resource: params.get('resource') || '',
    responseType: params.get('response_type') || '',
  };
}

async function readParams(req: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(req);
  return parseFormBody(body, contentType(req));
}

function allow(ctx: OAuthContext, res: ServerResponse, req: IncomingMessage, bucket: keyof typeof RATE_LIMITS): boolean {
  const ip = clientAddress(req, ctx.config.trustProxy);
  const result = ctx.rateLimiter.take(`${bucket}:${ip}`, RATE_LIMITS[bucket]);
  if (result.allowed) return true;
  sendJson(res, 429, { error: 'rate_limited', error_description: 'Too many requests.' }, {
    ...corsHeaders(),
    'retry-after': String(result.retryAfterSeconds),
  });
  return false;
}

function callbackUrl(redirectUri: string, query: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function pendingCookie(id: string, secure: boolean): string {
  const parts = [`${PENDING_COOKIE}=${encodeURIComponent(id)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function basicCredentials(req: IncomingMessage): { id: string; secret: string } | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(value.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { id: decodeURIComponent(decoded.slice(0, separator)), secret: decodeURIComponent(decoded.slice(separator + 1)) };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  };
}

function methodNotAllowed(res: ServerResponse, allowHeader: string): boolean {
  sendJson(res, 405, { error: 'invalid_request', error_description: 'Method not allowed.' }, { allow: allowHeader });
  return true;
}
