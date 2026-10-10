interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory sliding-window limiter.
 * NOTE: on serverless every instance has its own counters, so this is best-effort defence in depth.
 * Put Vercel Firewall / Cloudflare rate limiting in front for hard guarantees. Brute-force on login is
 * additionally stopped by the DB-backed account lockout in AuthService.
 */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  hit(key: string, limit: number, windowSec: number, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    if (this.buckets.size > 10_000) this.prune(now);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return { allowed: true, retryAfterSec: 0 };
    }
    existing.count += 1;
    if (existing.count > limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  private prune(now: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
