import type { Database } from "bun:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import type { Config } from "./config.ts";
import { newId } from "./crypto.ts";

export type ChallengeKind = "login" | "registration" | "recent_auth";

/**
 * §9 never says how `/auth/challenge` is matched back to `/auth/login`. With discoverable
 * credentials the client sends no identifier, so the challenge value is the key: it is stored on
 * issue, and login finds the row by the challenge inside `clientDataJSON`. Single-use, short TTL,
 * no cookie — which also keeps login working in a browser profile that has never seen the site.
 */
export function storeChallenge(
  db: Database,
  cfg: Config,
  challenge: string,
  kind: ChallengeKind,
  accountId: string | null = null,
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO challenges (challenge, kind, account_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(challenge, kind, accountId, now + cfg.ttl.challenge, now);
}

/** Consumes a challenge, returning false if it is unknown, expired or already spent. */
export function consumeChallenge(db: Database, challenge: string, kind: ChallengeKind, now = Date.now()): boolean {
  const changes = db
    .query(
      `UPDATE challenges SET consumed_at = ?
       WHERE challenge = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, challenge, kind, now).changes;
  return changes === 1;
}

/** The challenge a WebAuthn response was signed over, read out of its clientDataJSON. */
export function challengeOf(clientDataJSON: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

export async function registrationOptions(
  db: Database,
  cfg: Config,
  input: { accountId: string | null; email: string; existingIds: string[] },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpId,
    // A stable per-account handle; for a not-yet-created account any id works, since the account
    // row is written by POST /keys in the same flow.
    userID: new TextEncoder().encode(input.accountId ?? newId()),
    userName: input.email,
    // The relay never verifies attestation chains (§4.3), so do not ask for one.
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: input.existingIds.map((id) => ({ id })),
  });
  storeChallenge(db, cfg, options.challenge, "registration", input.accountId);
  return options;
}

export async function authenticationOptions(
  db: Database,
  cfg: Config,
  kind: ChallengeKind = "login",
  accountId: string | null = null,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials: discoverable credentials let the authenticator offer the right passkey,
  // so login needs no email and reveals nothing about which addresses exist.
  const options = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: "required" });
  storeChallenge(db, cfg, options.challenge, kind, accountId);
  return options;
}
