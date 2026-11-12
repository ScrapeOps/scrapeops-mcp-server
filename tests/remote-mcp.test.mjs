import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
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
      assert.deepEqual(names, ['extract_data', 'maps_web', 'return_links']);
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
      assert.deepEqual(names, ['extract_data', 'maps_web', 'return_links']);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : error}\n${stderr}`);
    } finally {
      child.kill();
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
