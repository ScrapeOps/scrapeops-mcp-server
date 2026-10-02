export interface HttpConfig {
  host: string;
  port: number;
  publicBaseUrl?: string;
  oauthEnabled: boolean;
  requireOauth: boolean;
  encryptionKey?: Buffer;
  dataDir: string;
  backendUrl: string;
  trustProxy: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  envApiKey?: string;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const requireOauth = env.REQUIRE_OAUTH === 'true';
  const oauthFlag = env.OAUTH_ENABLED;
  const hasEncryptionKey = Boolean(env.TOKEN_ENCRYPTION_KEY);
  const oauthEnabled =
    oauthFlag === 'true' || (oauthFlag !== 'false' && (requireOauth || hasEncryptionKey));

  return {
    host: env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: env.PORT ? Number(env.PORT) : 8080,
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, ''),
    oauthEnabled,
    requireOauth,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY ? parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY) : undefined,
    dataDir: env.DATA_DIR || './data',
    backendUrl: (env.SCRAPEOPS_BACKEND_URL || 'https://backend.scrapeops.io/v1').replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.NODE_ENV === 'production',
    accessTokenTtlSeconds: positiveInt(env.ACCESS_TOKEN_TTL_SECONDS, 60 * 60),
    refreshTokenTtlSeconds: positiveInt(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60),
    authCodeTtlSeconds: positiveInt(env.AUTH_CODE_TTL_SECONDS, 5 * 60),
    envApiKey: env.SCRAPEOPS_API_KEY,
  };
}

export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : undefined;
  const key = hex ?? Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or standard base64');
  }
  return key;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
