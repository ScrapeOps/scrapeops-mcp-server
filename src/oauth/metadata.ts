export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

export function authorizationServerMetadata(baseUrl: string): OAuthMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['scrape'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  };
}

export function protectedResourceMetadata(baseUrl: string): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['scrape'],
    bearer_methods_supported: ['header'],
    resource_name: 'ScrapeOps MCP',
  };
}

export function wwwAuthenticate(baseUrl: string, error?: 'invalid_token' | 'invalid_request'): string {
  const parts = [
    'Bearer realm="scrapeops"',
    `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    'scope="scrape"',
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}
