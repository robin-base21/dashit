import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { newId, newToken, sha256 } from "./crypto.ts";

export interface SessionRow {
  id: string;
  account_id: string;
  credential_id: string | null;
  access_expires_at: number;
  refresh_expires_at: number;
  authed_at: number;
  revoked_at: number | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Issues a fresh pair. Only the hashes are stored, so a dump of the relay database does not hand
 * anyone a working session.
 */
export function issueSession(
  db: Database,
  cfg: Config,
  input: { account_id: string; credential_id: string | null },
  now = Date.now(),
): TokenPair {
  const access = newToken();
  const refresh = newToken();
  db.query(
    `INSERT INTO sessions (id, account_id, credential_id, access_hash, access_expires_at,
                           refresh_hash, refresh_expires_at, authed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    input.account_id,
    input.credential_id,
    sha256(access),
    now + cfg.ttl.access,
    sha256(refresh),
    now + cfg.ttl.refresh,
    now,
    now,
  );
  return { access_token: access, refresh_token: refresh, expires_in: Math.floor(cfg.ttl.access / 1000) };
}

/** The session a bearer access token names, or null when unknown, expired or revoked. */
export function sessionByAccess(db: Database, token: string, now = Date.now()): SessionRow | null {
  return (
    db
      .query<SessionRow, [string, number]>(
        `SELECT id, account_id, credential_id, access_expires_at, refresh_expires_at, authed_at, revoked_at
         FROM sessions WHERE access_hash = ? AND revoked_at IS NULL AND access_expires_at > ?`,
      )
      .get(sha256(token), now) ?? null
  );
}

/**
 * Rotates a refresh token: the presented one is spent whether or not the caller sees the response,
 * so a stolen token cannot be replayed after the legitimate client has used it.
 */
export function rotateRefresh(db: Database, cfg: Config, token: string, now = Date.now()): TokenPair | null {
  const row = db
    .query<SessionRow, [string, number]>(
      `SELECT id, account_id, credential_id, access_expires_at, refresh_expires_at, authed_at, revoked_at
       FROM sessions WHERE refresh_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?`,
    )
    .get(sha256(token), now);
  if (!row) return null;

  const access = newToken();
  const refresh = newToken();
  db.query(
    `UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?
     WHERE id = ?`,
  ).run(sha256(access), now + cfg.ttl.access, sha256(refresh), now + cfg.ttl.refresh, row.id);
  return { access_token: access, refresh_token: refresh, expires_in: Math.floor(cfg.ttl.access / 1000) };
}

export function revokeSession(db: Database, id: string, now = Date.now()): void {
  db.query(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id);
}

export function revokeSessionsForAccount(db: Database, accountId: string, now = Date.now()): void {
  db.query(`UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).run(now, accountId);
}

export function revokeSessionsForCredential(db: Database, credentialId: string, now = Date.now()): void {
  db.query(`UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL`).run(now, credentialId);
}

/** Whether a passkey assertion happened recently enough for a sensitive change (§4.7). */
export function hasRecentAuth(session: SessionRow, cfg: Config, now = Date.now()): boolean {
  return now - session.authed_at <= cfg.ttl.recentAuth;
}
