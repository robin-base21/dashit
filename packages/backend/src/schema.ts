/**
 * Relay-side schema (ARCHITECTURE.md §9). Unlike the client's synced tables these are ordinary
 * SQLite and carry no CRR constraints, so they are free to use FOREIGN KEY, UNIQUE and CHECK.
 *
 * Deviations from §9's table list, both deliberate:
 * - `pending_accounts` is folded into `email_codes` with a `purpose` column: a pending account is
 *   an unverified email plus a code, and one table means one lifecycle, one rate-limit path and
 *   one expiry sweep.
 * - `grants` is added for the short-lived `reg_token` / `enroll_token`, which §9 issues but never
 *   gives a home.
 *
 * `recovery` and the sync tables (`envelopes`, `snapshots`) are not here yet: recovery is Phase 3,
 * sync is the next stage.
 */

export interface Migration {
  version: number;
  statements: string[];
}

const v1: Migration = {
  version: 1,
  statements: [
    `CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY NOT NULL,
      email       TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    )`,
    // One live account per address; a deleted one must not block re-registration.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_live ON accounts(email) WHERE deleted_at IS NULL`,

    // Codes for every purpose. `email` is the rate-limit and lookup key; `account_id` is set only
    // for purposes that already know the account (enrolment).
    `CREATE TABLE IF NOT EXISTS email_codes (
      id          TEXT PRIMARY KEY NOT NULL,
      purpose     TEXT    NOT NULL CHECK (purpose IN ('register', 'enroll')),
      email       TEXT    NOT NULL,
      account_id  TEXT REFERENCES accounts(id),
      code_hash   TEXT    NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at  INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes(email, purpose, consumed_at)`,

    // Single-use tokens proving a code was verified: reg_token creates an account, enroll_token
    // adds a credential to an existing one.
    `CREATE TABLE IF NOT EXISTS grants (
      token_hash  TEXT PRIMARY KEY NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('reg', 'enroll')),
      email       TEXT,
      account_id  TEXT REFERENCES accounts(id),
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at  INTEGER NOT NULL
    )`,

    // Keyed by the challenge itself: with discoverable credentials the client sends no identifier,
    // so login finds the row by the challenge inside clientDataJSON.
    `CREATE TABLE IF NOT EXISTS challenges (
      challenge   TEXT PRIMARY KEY NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('login', 'registration', 'recent_auth')),
      account_id  TEXT REFERENCES accounts(id),
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at  INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS credentials (
      id            TEXT PRIMARY KEY NOT NULL,      -- base64url credential id
      account_id    TEXT    NOT NULL REFERENCES accounts(id),
      public_key    BLOB    NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,                           -- JSON array
      label         TEXT    NOT NULL DEFAULT 'Passkey',
      -- Whether the authenticator offers the PRF extension. Phase 3 wraps the DEK with it; the
      -- PRF *output* is key material and never leaves the device.
      prf_capable   INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_credentials_account ON credentials(account_id)`,

    // One wrapped DEK per credential. Null throughout Phase 2 — there is no DEK yet (§4.1).
    `CREATE TABLE IF NOT EXISTS wrapped_keys (
      credential_id TEXT PRIMARY KEY NOT NULL REFERENCES credentials(id),
      account_id    TEXT    NOT NULL REFERENCES accounts(id),
      method        TEXT    NOT NULL CHECK (method IN ('passkey_prf', 'recovery_key', 'none')),
      wrapped_dek   TEXT,
      created_at    INTEGER NOT NULL
    )`,

    // Opaque access and refresh tokens, stored hashed. Rotating the refresh token replaces the row.
    `CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY NOT NULL,
      account_id         TEXT    NOT NULL REFERENCES accounts(id),
      -- Revoked sessions outlive the credential they were created with, so the link is dropped
      -- rather than blocking the delete.
      credential_id      TEXT REFERENCES credentials(id) ON DELETE SET NULL,
      access_hash        TEXT    NOT NULL,
      access_expires_at  INTEGER NOT NULL,
      refresh_hash       TEXT    NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      -- Last passkey assertion, for sensitive changes that require recent_auth.
      authed_at          INTEGER NOT NULL,
      revoked_at         INTEGER,
      created_at         INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_access ON sessions(access_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`,
  ],
};

/**
 * Sync storage (§3.4, §3.5). The relay holds envelopes as opaque blobs: it reads only the header
 * it was handed and never the payload, which is plaintext CBOR in Phase 2 and ciphertext in
 * Phase 3 without this schema changing.
 */
const v2: Migration = {
  version: 2,
  statements: [
    `CREATE TABLE IF NOT EXISTS envelopes (
      account_id     TEXT    NOT NULL REFERENCES accounts(id),
      -- Strictly increasing per account; what a client pulls "since".
      seq            INTEGER NOT NULL,
      site_id        TEXT    NOT NULL,
      schema_version INTEGER NOT NULL,
      -- The producer's db_version range, so one site's envelopes apply in order.
      from_version   INTEGER NOT NULL,
      to_version     INTEGER NOT NULL,
      payload        BLOB    NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (account_id, seq)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_envelopes_pull ON envelopes(account_id, seq, site_id)`,

    `CREATE TABLE IF NOT EXISTS snapshots (
      account_id     TEXT    PRIMARY KEY NOT NULL REFERENCES accounts(id),
      -- The relay seq this snapshot already contains; pulling resumes from here.
      covers_seq     INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      payload        BLOB    NOT NULL,
      created_at     INTEGER NOT NULL
    )`,

    // The floor a client may pull from. Raised by pruning, and what turns a too-old `since` into
    // a 410 rather than a silently incomplete reply.
    `ALTER TABLE accounts ADD COLUMN oldest_retained_seq INTEGER NOT NULL DEFAULT 0`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [v1, v2];
export const RELAY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
