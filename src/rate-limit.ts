interface Bucket {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  take(key: string, bucket: Bucket): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < bucket.windowMs);
    if (recent.length >= bucket.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + bucket.windowMs - now) / 1000));
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 20_000) {
      this.prune(now);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number): void {
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((timestamp) => now - timestamp > 60 * 60 * 1000)) {
        this.hits.delete(key);
      }
    }
  }
}

export const RATE_LIMITS = {
  authorize: { limit: 30, windowMs: 60_000 },
  login: { limit: 10, windowMs: 15 * 60_000 },
  token: { limit: 60, windowMs: 60_000 },
  register: { limit: 20, windowMs: 60 * 60_000 },
  revoke: { limit: 30, windowMs: 60_000 },
  mcp: { limit: 120, windowMs: 60_000 },
} as const;
