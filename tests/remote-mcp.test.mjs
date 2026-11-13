import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Sorted tool names registered by createScrapeOpsServer (proxy + analysis tools). */
const EXPECTED_TOOL_NAMES = [
  'analyze_api_endpoints',
  'analyze_scraping_difficulty',
  'check_css_selectors',
  'check_js_rendering',
  'check_scraping_legality',
  'classify_page_type',
  'detect_anti_bots',
  'detect_tech_stack',
  'extract_data',
  'generate_data_schema',
  'identify_data_sources',
  'maps_web',
  'return_links',
];

const capturedUrls = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://proxy.scrapeops.io')) {
    capturedUrls.push(url);
    return new Response('<html><title>example</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
  return originalFetch(input, init);
};

const { startHttpServer } = await import('../dist/http.js');
const { MemoryOAuthStore, SqliteOAuthStore } = await import('../dist/oauth/store.js');
const { encryptString, decryptString } = await import('../dist/oauth/crypto.js');
const { sessionFromAuthInfo } = await import('../dist/server.js');

describe('remote mcp', { concurrency: 1 }, () => {
  test('oauth discovery, connect, tool call, refresh, and revoke', async () => {
    const encryptionKey = randomBytes(32);
    const store = new MemoryOAuthStore();
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: true,
      requireOauth: true,
      encryptionKey,
      envApiKey: null,
      store,
      login: async () => [{ id: '42', name: 'Acme', apiKey: 'account-api-key' }],
    });

    try {
      const base = server.baseUrl;
      const unauthenticated = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(unauthenticated.status, 401);
      const challenge = unauthenticated.headers.get('www-authenticate') || '';
      assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

      const resourceName = challenge.match(/resource_metadata="([^"]+)"/)[1];
      const resourceMetadata = await (await fetch(resourceName)).json();
      assert.equal(resourceMetadata.resource, `${base}/mcp`);
      assert.deepEqual(resourceMetadata.authorization_servers, [base]);

      const authorizationMetadata = await (await fetch(resourceMetadata.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
      assert.equal(authorizationMetadata.authorization_endpoint, `${base}/authorize`);
      assert.equal(authorizationMetadata.token_endpoint, `${base}/token`);
      assert.equal(authorizationMetadata.registration_endpoint, `${base}/register`);
      assert.ok(authorizationMetadata.code_challenge_methods_supported.includes('S256'));
      assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, true);

      const redirectUri = 'http://127.0.0.1:9/callback';
      const registration = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude Test',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      assert.equal(registration.status, 201);
      const client = await registration.json();
      assert.equal(client.client_secret, undefined);

      const verifier = randomBytes(32).toString('base64url');
      const challengeCode = createHash('sha256').update(verifier).digest('base64url');
      const state = 'state-1';
      const authorize = new URL(`${base}/authorize`);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', client.client_id);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('code_challenge', challengeCode);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('scope', 'scrape');
      authorize.searchParams.set('resource', `${base}/mcp`);

      const loginPage = await fetch(authorize);
      assert.equal(loginPage.status, 200);
      assert.match(await loginPage.text(), /Connect ScrapeOps/);

      const login = await fetch(`${base}/authorize/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...Object.fromEntries(authorize.searchParams),
          email: 'user@example.com',
          password: 'secret',
        }),
      });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const consent = await fetch(`${base}/authorize/consent`, { headers: { cookie } });
      assert.equal(consent.status, 200);
      const loginHtml = await consent.text();
      assert.equal(loginHtml.includes('account-api-key'), false);
      assert.equal(loginHtml.includes('action="/authorize/decision"'), false);
      assert.match(loginHtml, /Approving…/);
      assert.match(loginHtml, /class="spinner"/);
      const approveHref = loginHtml.match(/href="([^"]*decision=approve[^"]*)"/)[1].replaceAll('&amp;', '&');
      const approveUrl = new URL(approveHref, base);

      const decision = await fetch(approveUrl, {
        redirect: 'manual',
        headers: { cookie },
      });
      assert.equal(decision.status, 302);
      const location = new URL(decision.headers.get('location'));
      assert.equal(location.searchParams.get('state'), state);
      assert.equal(location.searchParams.get('iss'), base);
      const code = location.searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: `${base}/mcp`,
        }),
      });
      assert.equal(tokenResponse.status, 200);
      const tokens = await tokenResponse.json();
      assert.equal(tokens.token_type, 'Bearer');
      assert.equal(JSON.stringify(tokens).includes('account-api-key'), false);

      const initialize = await mcp(base, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });
      assert.equal(initialize.response.status, 200, initialize.text);
      assert.equal(initialize.message.result.serverInfo.name, 'scrapeops-mcp');

      await mcp(base, tokens.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const tools = await mcp(base, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const names = tools.message.result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, EXPECTED_TOOL_NAMES);
      for (const tool of tools.message.result.tools) {
        assert.equal(typeof tool.annotations.title, 'string');
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
      }

      const call = await mcp(base, tokens.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'maps_web', arguments: { url: 'https://example.com' } },
      });
      assert.equal(call.response.status, 200, call.text);
      assert.equal(call.text.includes('account-api-key'), false);
      assert.ok(capturedUrls.some((url) => url.includes('api_key=account-api-key')));
      assert.ok(capturedUrls.some((url) => url.includes('url=https%3A%2F%2Fexample.com') || url.includes('url=https://example.com')));

      const refreshed = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        }),
      });
      assert.equal(refreshed.status, 200);
      const nextTokens = await refreshed.json();
      const stillWorks = await mcp(base, nextTokens.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
      assert.equal(stillWorks.response.status, 200);

      const reuse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        }),
      });
      assert.equal(reuse.status, 400);
      const afterReuse = await mcp(base, nextTokens.access_token, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
      assert.equal(afterReuse.response.status, 401);

      const relogin = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: nextTokens.refresh_token,
          client_id: client.client_id,
        }),
      });
      assert.equal(relogin.status, 400);
    } finally {
      await server.close();
    }
  });

  test('local http api key mode stays available without oauth', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: 'local-http-key',
    });
    try {
      const health = await fetch(`${server.baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const initialize = await mcp(server.baseUrl, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'local-http', version: '1.0.0' },
        },
      });
      assert.equal(initialize.response.status, 200, initialize.text);
      assert.match(initialize.response.headers.get('content-type') || '', /^application\/json/);

      const listed = await mcp(server.baseUrl, undefined, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(listed.response.status, 200, listed.text);
      const called = await mcp(server.baseUrl, undefined, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'maps_web', arguments: { url: 'https://example.com' } },
      });
      assert.equal(called.response.status, 200, called.text);
      assert.ok(capturedUrls.some((url) => url.includes('api_key=local-http-key')));

      const initializeLatest = await mcp(server.baseUrl, undefined, {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'local-http', version: '1.0.0' },
        },
      });
      assert.equal(initializeLatest.message.result.protocolVersion, '2025-11-25');
    } finally {
      await server.close();
    }
  });

  test('http serves 2026-07-28 without initialize', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: 'modern-key',
    });
    try {
      const discovered = await mcpModern(server.baseUrl, { method: 'server/discover' });
      assert.equal(discovered.response.status, 200, discovered.text);
      assert.ok(discovered.message.result.supportedVersions.includes('2026-07-28'));

      const listed = await mcpModern(server.baseUrl, { method: 'tools/list' });
      assert.equal(listed.response.status, 200, listed.text);
      assert.equal(listed.message.result.resultType, 'complete');

      const called = await mcpModern(server.baseUrl, {
        method: 'tools/call',
        name: 'maps_web',
        params: { name: 'maps_web', arguments: { url: 'https://example.com' } },
      });
      assert.equal(called.response.status, 200, called.text);
      assert.equal(called.response.headers.get('mcp-session-id'), null);
      assert.ok(capturedUrls.some((url) => url.includes('api_key=modern-key')));
    } finally {
      await server.close();
    }
  });

  test('modern request without bearer token is challenged', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: true,
      requireOauth: true,
      encryptionKey: randomBytes(32),
      envApiKey: null,
      store: new MemoryOAuthStore(),
      login: async () => [],
    });
    try {
      const challenged = await mcpModern(server.baseUrl, { method: 'tools/list' });
      assert.equal(challenged.response.status, 401);
      assert.match(challenged.response.headers.get('www-authenticate') || '', /resource_metadata="/);
    } finally {
      await server.close();
    }
  });

  test('preflight allows modern MCP headers', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: 'preflight-key',
    });
    try {
      const preflight = await originalFetch(`${server.baseUrl}/mcp`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://claude.ai',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'mcp-method, mcp-name, mcp-protocol-version, authorization',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://claude.ai');
      const allowed = preflight.headers.get('access-control-allow-headers') || '';
      for (const name of ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'authorization']) {
        assert.ok(allowed.includes(name), `${name} missing from ${allowed}`);
      }
    } finally {
      await server.close();
    }
  });

  test('concurrent sessions keep their own api key', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: null,
    });
    try {
      const call = (apiKey) =>
        mcpModern(server.baseUrl, {
          apiKey,
          method: 'tools/call',
          name: 'maps_web',
          params: { name: 'maps_web', arguments: { url: `https://example.com/${apiKey}` } },
        });
      const [a, b] = await Promise.all([call('key-a'), call('key-b')]);
      assert.equal(a.response.status, 200, a.text);
      assert.equal(b.response.status, 200, b.text);
      assert.ok(capturedUrls.some((url) => url.includes('api_key=key-a') && url.includes('example.com%2Fkey-a')));
      assert.ok(capturedUrls.some((url) => url.includes('api_key=key-b') && url.includes('example.com%2Fkey-b')));
      assert.equal(capturedUrls.some((url) => url.includes('api_key=key-a') && url.includes('example.com%2Fkey-b')), false);
    } finally {
      await server.close();
    }
  });

  test('legacy sse paths return a migration message', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: 'sse-key',
    });
    try {
      const expected = {
        error: 'endpoint_removed',
        error_description:
          'The HTTP+SSE transport (/sse, /messages) was removed in @scrapeops/mcp 2.0.0. Use Streamable HTTP at /mcp instead.',
        mcp_endpoint: '/mcp',
        docs: 'https://scrapeops.io/docs/mcp/overview/',
      };
      const sse = await originalFetch(`${server.baseUrl}/sse`);
      assert.equal(sse.status, 410);
      assert.deepEqual(await sse.json(), expected);
      const messages = await originalFetch(`${server.baseUrl}/messages`, { method: 'POST', body: '{}' });
      assert.equal(messages.status, 410);
      assert.deepEqual(await messages.json(), expected);
    } finally {
      await server.close();
    }
  });

  test('stdio transport still lists tools with SCRAPEOPS_API_KEY', async () => {
    const env = { ...process.env };
    delete env.PORT;
    delete env.MCP_TRANSPORT;
    delete env.OAUTH_ENABLED;
    delete env.REQUIRE_OAUTH;
    env.SCRAPEOPS_API_KEY = 'stdio-key';

    const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    const messages = [];
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        messages.push(JSON.parse(line));
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      });
      const initialized = await waitForMessage(messages, (message) => message.id === 1);
      assert.equal(initialized.result.serverInfo.name, 'scrapeops-mcp');
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      const listed = await waitForMessage(messages, (message) => message.id === 2);
      const names = listed.result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, EXPECTED_TOOL_NAMES);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : error}\n${stderr}`);
    } finally {
      child.kill();
    }
  });

  test('stdio answers server/discover for 2026-07-28', async () => {
    const child = spawnStdio('stdio-key');
    try {
      child.write({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta('stdio-modern') } });
      const discovered = await child.waitFor((message) => message.id === 1);
      assert.ok(discovered.result.supportedVersions.includes('2026-07-28'), JSON.stringify(discovered));
      assert.equal(discovered.result.resultType, 'complete');

      child.write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta('stdio-modern') } });
      const listed = await child.waitFor((message) => message.id === 2);
      assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), EXPECTED_TOOL_NAMES);
      assert.equal(typeof listed.result.ttlMs, 'number');
      assert.ok(['public', 'private'].includes(listed.result.cacheScope));
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : error}\n${child.stderr()}`);
    } finally {
      child.kill();
    }
  });

  test('http sessions never fall back to the operator api key', async () => {
    const previous = process.env.SCRAPEOPS_API_KEY;
    process.env.SCRAPEOPS_API_KEY = 'operator-key';
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      oauthEnabled: false,
      requireOauth: false,
      envApiKey: null,
    });
    try {
      assert.throws(() => sessionFromAuthInfo(undefined), /authenticated/);
      const session = sessionFromAuthInfo({ token: 'caller-key', clientId: 'c', scopes: ['scrape'], extra: { authType: 'api_key' } });
      assert.equal(session.scrapeOpsApiKey, 'caller-key');

      const listed = await mcp(server.baseUrl, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(listed.response.status, 401, listed.text);
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.SCRAPEOPS_API_KEY;
      else process.env.SCRAPEOPS_API_KEY = previous;
    }
  });

  test('sqlite store revokes an account without keeping plaintext api keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scrapeops-mcp-'));
    const store = new SqliteOAuthStore(join(directory, 'oauth.sqlite'));
    const key = randomBytes(32);
    const ciphertext = encryptString('secret-api-key', key);
    assert.equal(ciphertext.includes('secret-api-key'), false);
    assert.equal(decryptString(ciphertext, key), 'secret-api-key');

    await store.saveToken({
      tokenHash: 'hash',
      kind: 'access',
      familyId: 'family',
      clientId: 'client',
      accountId: '42',
      apiKeyCiphertext: ciphertext,
      scope: 'scrape',
      expiresAt: Date.now() + 1000,
      revoked: false,
    });
    assert.equal((await store.revokeByAccount('42')) > 0, true);
    assert.equal((await store.getToken('hash')).revoked, true);
  });
});

async function mcp(base, token, body) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await originalFetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, message: text ? parseMcp(text, response.headers.get('content-type') || '') : null };
}

let modernId = 1000;

async function mcpModern(base, { token, apiKey, method, params = {}, name }) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-method': method,
    'mcp-protocol-version': '2026-07-28',
  };
  if (name) headers['mcp-name'] = name;
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['scrapeops-api-key'] = apiKey;
  const body = {
    jsonrpc: '2.0',
    id: modernId++,
    method,
    params: { ...params, _meta: modernMeta('http-modern') },
  };
  const response = await originalFetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { response, text, message: text ? parseMcp(text, response.headers.get('content-type') || '') : null };
}

function parseMcp(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
    return data.find((message) => message.id !== undefined) ?? data.at(-1);
  }
  return JSON.parse(text);
}

function modernMeta(clientName) {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' },
  };
}

function spawnStdio(apiKey) {
  const env = { ...process.env };
  delete env.PORT;
  delete env.MCP_TRANSPORT;
  delete env.OAUTH_ENABLED;
  delete env.REQUIRE_OAUTH;
  env.SCRAPEOPS_API_KEY = apiKey;

  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    write: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor: (predicate) => waitForMessage(messages, predicate),
    stderr: () => stderr,
    kill: () => child.kill(),
  };
}

function waitForMessage(messages, predicate) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for MCP message: ${JSON.stringify(messages)}`));
      }
    }, 20);
  });
}
