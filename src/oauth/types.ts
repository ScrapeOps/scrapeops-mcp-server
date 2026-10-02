export interface OAuthClient {
  clientId: string;
  clientSecretHash?: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  createdAt: number;
}

export interface ScrapeOpsAccountRef {
  id: string;
  name: string;
  apiKeyCiphertext: string;
}

export interface PendingLogin {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  resource?: string;
  userEmail: string;
  accounts: ScrapeOpsAccountRef[];
  expiresAt: number;
}

export interface AuthCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  resource?: string;
  accountId: string;
  apiKeyCiphertext: string;
  expiresAt: number;
}

export interface TokenRecord {
  tokenHash: string;
  kind: 'access' | 'refresh';
  familyId: string;
  clientId: string;
  accountId: string;
  apiKeyCiphertext: string;
  scope: string;
  expiresAt: number;
  revoked: boolean;
}

export interface OAuthStore {
  saveClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  savePending(pending: PendingLogin): Promise<void>;
  getPending(id: string): Promise<PendingLogin | null>;
  deletePending(id: string): Promise<void>;
  saveAuthCode(code: AuthCodeRecord): Promise<void>;
  consumeAuthCode(codeHash: string): Promise<AuthCodeRecord | null>;
  saveToken(token: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | null>;
  revokeToken(tokenHash: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeByAccount(accountId: string): Promise<number>;
}

export interface ResolvedAccessToken {
  accountId: string;
  apiKey: string;
  clientId: string;
  scope: string;
}
