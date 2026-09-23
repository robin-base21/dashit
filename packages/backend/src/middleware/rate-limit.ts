import type { Context, MiddlewareHandler } from "hono";

/**
 * Token buckets held in memory (ARCHITECTURE.md §9). In-process is the right scope for a
 * single-instance relay; a multi-instance deployment would need a shared store, which is noted
 * rather than built.
 */
interface Bucket {
  tokens: number;
  refilledAt: number;
}

export interface Limit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  #buckets = new Map<string, Bucket>();
  /** Keys locked out until a timestamp, for repeated failed code checks. */
  #locks = new Map<string, number>();
  #scale: number;

  /**
   * `scale` multiplies every limit. It exists for test environments, where a whole suite shares one
   * IP and one long-lived process: the documented numbers would otherwise make a test's outcome
   * depend on how many ran before it. Production always uses 1.
   */
  constructor(scale = 1) {
    this.#scale = Math.max(1, scale);
  }

  /** Consumes one token. False means the caller is over its limit. */
  take(key: string, limits: Limit, now = Date.now()): boolean {
    const limit = limits.limit * this.#scale;
    const { windowMs } = limits;
    if (this.isLocked(key, now)) return false;
    const b = this.#buckets.get(key) ?? { tokens: limit, refilledAt: now };
    // Continuous refill: `limit` tokens per window, so a burst recovers gradually rather than all
    // at once on a window boundary.
    b.tokens = Math.min(limit, b.tokens + ((now - b.refilledAt) / windowMs) * limit);
    b.refilledAt = now;
    if (b.tokens < 1) {
      this.#buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.#buckets.set(key, b);
    return true;
  }

  lock(key: string, forMs: number, now = Date.now()): void {
    this.#locks.set(key, now + forMs);
  }

  isLocked(key: string, now = Date.now()): boolean {
    const until = this.#locks.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    this.#locks.delete(key);
    return false;
  }

  reset(): void {
    this.#buckets.clear();
    this.#locks.clear();
  }
}

/** Trusted only behind a proxy that sets it; otherwise a client could forge its own bucket. */
export function clientIp(c: Context): string {
  if (process.env.DASHIT_TRUST_PROXY === "1") {
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
  }
  return c.req.header("x-real-ip") ?? "local";
}

export function byIp(limiter: RateLimiter, name: string, limit: Limit): MiddlewareHandler {
  return async (c, next) => {
    if (!limiter.take(`${name}:ip:${clientIp(c)}`, limit)) return c.json({ error: "rate_limited" }, 429);
    await next();
  };
}

/** The §9 limits, in one place so the tests can assert against the same numbers. */
export const LIMITS = {
  codeCheck: { limit: 5, windowMs: 60_000 },
  codeCheckPerEmail: { limit: 10, windowMs: 3_600_000 },
  codeIssuePerEmail: { limit: 3, windowMs: 3_600_000 },
  codeIssuePerIp: { limit: 20, windowMs: 3_600_000 },
  assertion: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, Limit>;

/** Failed code/verifier checks before an address is locked out, and for how long. */
export const CODE_LOCKOUT = { failures: 10, forMs: 3_600_000 } as const;
