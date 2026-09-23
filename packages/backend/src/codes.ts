import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { newId, newToken, sha256, timingSafeEqual } from "./crypto.ts";
import { CODE_LOCKOUT, LIMITS, type RateLimiter } from "./middleware/rate-limit.ts";

export type CodePurpose = "register" | "enroll";
export type GrantKind = "reg" | "enroll";

/** Issues a code, superseding any live one for the same address and purpose. */
export function issueCode(
  db: Database,
  cfg: Config,
  input: { purpose: CodePurpose; email: string; account_id?: string | null; code: string },
  now = Date.now(),
): void {
  db.query(`UPDATE email_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL`).run(
    now,
    input.email,
    input.purpose,
  );
  db.query(
    `INSERT INTO email_codes (id, purpose, email, account_id, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), input.purpose, input.email, input.account_id ?? null, sha256(input.code), now + cfg.ttl.emailCode, now);
}

export type CheckResult = { ok: true; account_id: string | null } | { ok: false; reason: "invalid" | "locked" };

/**
 * Verifies a code. A wrong guess burns an attempt; running out of attempts kills the code, and
 * repeated failures lock the address (§9). Deliberately returns one undifferentiated `invalid` for
 * wrong, expired, spent and never-issued, so nothing here says whether an address exists.
 */
export function checkCode(
  db: Database,
  cfg: Config,
  limiter: RateLimiter,
  input: { purpose: CodePurpose; email: string; code: string },
  now = Date.now(),
): CheckResult {
  const lockKey = `code:email:${input.email}`;
  if (limiter.isLocked(lockKey, now)) return { ok: false, reason: "locked" };

  const row = db
    .query<{ id: string; code_hash: string; attempts: number; account_id: string | null }, [string, string, number]>(
      `SELECT id, code_hash, attempts, account_id FROM email_codes
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.email, input.purpose, now);

  if (!row) {
    countFailure(limiter, lockKey, now);
    return { ok: false, reason: "invalid" };
  }
  if (!timingSafeEqual(row.code_hash, sha256(input.code))) {
    const attempts = row.attempts + 1;
    if (attempts >= cfg.maxCodeAttempts) {
      db.query(`UPDATE email_codes SET attempts = ?, consumed_at = ? WHERE id = ?`).run(attempts, now, row.id);
    } else {
      db.query(`UPDATE email_codes SET attempts = ? WHERE id = ?`).run(attempts, row.id);
    }
    countFailure(limiter, lockKey, now);
    return { ok: false, reason: "invalid" };
  }

  db.query(`UPDATE email_codes SET consumed_at = ? WHERE id = ?`).run(now, row.id);
  return { ok: true, account_id: row.account_id };
}

function countFailure(limiter: RateLimiter, key: string, now: number): void {
  // The bucket doubles as a failure counter: draining it is what trips the lockout.
  if (!limiter.take(`${key}:failures`, { limit: CODE_LOCKOUT.failures, windowMs: LIMITS.codeCheckPerEmail.windowMs }, now)) {
    limiter.lock(key, CODE_LOCKOUT.forMs, now);
  }
}

/** A single-use token proving a code was verified. */
export function issueGrant(
  db: Database,
  cfg: Config,
  input: { kind: GrantKind; email?: string | null; account_id?: string | null },
  now = Date.now(),
): string {
  const token = newToken();
  db.query(
    `INSERT INTO grants (token_hash, kind, email, account_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha256(token), input.kind, input.email ?? null, input.account_id ?? null, now + cfg.ttl.grant, now);
  return token;
}

export interface Grant {
  kind: GrantKind;
  email: string | null;
  account_id: string | null;
}

/** Reads a grant without spending it, so options can be issued before the credential exists. */
export function peekGrant(db: Database, token: string, now = Date.now()): Grant | null {
  return (
    db
      .query<Grant, [string, number]>(
        `SELECT kind, email, account_id FROM grants
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(sha256(token), now) ?? null
  );
}

export function consumeGrant(db: Database, token: string, now = Date.now()): Grant | null {
  const grant = peekGrant(db, token, now);
  if (!grant) return null;
  db.query(`UPDATE grants SET consumed_at = ? WHERE token_hash = ?`).run(now, sha256(token));
  return grant;
}
