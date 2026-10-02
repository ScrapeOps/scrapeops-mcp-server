import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { AuthCodeRecord, OAuthClient, OAuthStore, PendingLogin, TokenRecord } from './types.js';

export class MemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private pending = new Map<string, PendingLogin>();
  private codes = new Map<string, AuthCodeRecord & { used: boolean }>();
  private tokens = new Map<string, TokenRecord>();

  async saveClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    return this.clients.get(clientId) ?? null;
  }

  async savePending(pending: PendingLogin): Promise<void> {
    this.pending.set(pending.id, pending);
  }

  async getPending(id: string): Promise<PendingLogin | null> {
    const pending = this.pending.get(id);
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
      this.pending.delete(id);
      return null;
    }
    return pending;
  }

  async deletePending(id: string): Promise<void> {
    this.pending.delete(id);
  }

  async saveAuthCode(code: AuthCodeRecord): Promise<void> {
    this.codes.set(code.codeHash, { ...code, used: false });
  }

  async consumeAuthCode(codeHash: string): Promise<AuthCodeRecord | null> {
    const code = this.codes.get(codeHash);
    if (!code || code.used || code.expiresAt <= Date.now()) return null;
    code.used = true;
    return code;
  }

  async saveToken(token: TokenRecord): Promise<void> {
    this.tokens.set(token.tokenHash, token);
  }

  async getToken(tokenHash: string): Promise<TokenRecord | null> {
    const token = this.tokens.get(tokenHash);
    if (!token) return null;
    if (token.expiresAt <= Date.now()) return { ...token, revoked: true };
    return token;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    const token = this.tokens.get(tokenHash);
    if (token) token.revoked = true;
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.familyId === familyId) token.revoked = true;
    }
  }

  async revokeByAccount(accountId: string): Promise<number> {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.accountId === accountId && !token.revoked) {
        token.revoked = true;
        count += 1;
      }
    }
    return count;
  }
}

export class SqliteOAuthStore implements OAuthStore {
  private db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_logins (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        family_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family_id);
      CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account_id);
    `);
  }

  async saveClient(client: OAuthClient): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO clients (client_id, payload) VALUES (?, ?)').run(client.clientId, JSON.stringify(client));
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const row = this.db.prepare('SELECT payload FROM clients WHERE client_id = ?').get(clientId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as OAuthClient) : null;
  }

  async savePending(pending: PendingLogin): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO pending_logins (id, payload, expires_at) VALUES (?, ?, ?)')
      .run(pending.id, JSON.stringify(pending), pending.expiresAt);
  }

  async getPending(id: string): Promise<PendingLogin | null> {
    const row = this.db.prepare('SELECT payload, expires_at FROM pending_logins WHERE id = ?').get(id) as
      | { payload: string; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      await this.deletePending(id);
      return null;
    }
    return JSON.parse(row.payload) as PendingLogin;
  }

  async deletePending(id: string): Promise<void> {
    this.db.prepare('DELETE FROM pending_logins WHERE id = ?').run(id);
  }

  async saveAuthCode(code: AuthCodeRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO auth_codes (code_hash, payload, expires_at, used) VALUES (?, ?, ?, 0)')
      .run(code.codeHash, JSON.stringify(code), code.expiresAt);
  }

  async consumeAuthCode(codeHash: string): Promise<AuthCodeRecord | null> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT payload, expires_at, used FROM auth_codes WHERE code_hash = ?')
        .get(codeHash) as { payload: string; expires_at: number; used: number } | undefined;
      if (!row || row.used || row.expires_at <= Date.now()) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ?').run(codeHash);
      this.db.exec('COMMIT');
      return JSON.parse(row.payload) as AuthCodeRecord;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveToken(token: TokenRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tokens
          (token_hash, kind, family_id, account_id, payload, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token.tokenHash,
        token.kind,
        token.familyId,
        token.accountId,
        JSON.stringify(token),
        token.expiresAt,
        token.revoked ? 1 : 0
      );
  }

  async getToken(tokenHash: string): Promise<TokenRecord | null> {
    const row = this.db.prepare('SELECT payload FROM tokens WHERE token_hash = ?').get(tokenHash) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as TokenRecord) : null;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    const token = await this.getToken(tokenHash);
    if (!token) return;
    token.revoked = true;
    await this.saveToken(token);
  }

  async revokeFamily(familyId: string): Promise<void> {
    const rows = this.db.prepare('SELECT payload FROM tokens WHERE family_id = ?').all(familyId) as { payload: string }[];
    for (const row of rows) {
      const token = JSON.parse(row.payload) as TokenRecord;
      token.revoked = true;
      await this.saveToken(token);
    }
  }

  async revokeByAccount(accountId: string): Promise<number> {
    const rows = this.db.prepare('SELECT payload FROM tokens WHERE account_id = ? AND revoked = 0').all(accountId) as {
      payload: string;
    }[];
    for (const row of rows) {
      const token = JSON.parse(row.payload) as TokenRecord;
      token.revoked = true;
      await this.saveToken(token);
    }
    return rows.length;
  }
}

export function createOAuthStore(options: { dataDir?: string; store?: OAuthStore }): OAuthStore {
  if (options.store) return options.store;
  const filename = join(options.dataDir || './data', 'oauth.sqlite');
  return new SqliteOAuthStore(filename);
}
