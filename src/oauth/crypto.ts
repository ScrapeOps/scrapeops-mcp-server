import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const actual = pkceChallenge(verifier);
  return safeEqual(actual, challenge);
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function encryptString(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptString(payload: string, key: Buffer): string {
  const data = Buffer.from(payload, 'base64url');
  if (data.length < 12 + 16) {
    throw new Error('Invalid ciphertext');
  }
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return isLoopbackRedirect(uri);
}

/**
 * Exact match, plus RFC 8252 loopback where the port may differ from registration.
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  for (const candidate of registered) {
    let allowed: URL;
    try {
      allowed = new URL(candidate);
    } catch {
      continue;
    }
    if (requestedUrl.href === allowed.href) return true;
    if (!isLoopbackRedirect(requested) || !isLoopbackRedirect(candidate)) continue;
    if (
      requestedUrl.protocol === allowed.protocol &&
      requestedUrl.hostname === allowed.hostname &&
      requestedUrl.pathname === allowed.pathname &&
      requestedUrl.search === allowed.search
    ) {
      return true;
    }
  }
  return false;
}
