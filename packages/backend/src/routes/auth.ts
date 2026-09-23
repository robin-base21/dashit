import { Hono } from "hono";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AppEnv } from "../app-env.ts";
import { checkCode, issueCode, issueGrant } from "../codes.ts";
import { newEmailCode, normalizeEmail } from "../crypto.ts";
import { codeEmail, existingAccountEmail } from "../email.ts";
import { byIp, LIMITS } from "../middleware/rate-limit.ts";
import { requireSession } from "../middleware/session.ts";
import { issueSession, revokeSession, rotateRefresh } from "../sessions.ts";
import { authenticationOptions, challengeOf, consumeChallenge } from "../webauthn.ts";
import { readBody } from "../body.ts";

export function authRoutes(limiter: import("../middleware/rate-limit.ts").RateLimiter) {
  const app = new Hono<AppEnv>();

  /**
   * Always answers the same way whether or not the address is known — the response is the only
   * thing an attacker could use to enumerate accounts.
   */
  app.post("/register", byIp(limiter, "issue", LIMITS.codeIssuePerIp), async (c) => {
    const { db, config, email: mailer } = c.get("deps");
    const body = await readBody<{ email?: unknown }>(c);
    if (typeof body.email !== "string" || !body.email.includes("@")) return c.json({ error: "invalid_email" }, 400);
    const email = normalizeEmail(body.email);

    const constant = { ok: true } as Record<string, unknown>;
    if (!limiter.take(`issue:email:${email}`, LIMITS.codeIssuePerEmail)) return c.json(constant);

    const existing = db
      .query<{ id: string }, [string]>(`SELECT id FROM accounts WHERE email = ? AND deleted_at IS NULL`)
      .get(email);
    if (existing) {
      // No code, and the response says nothing — but the owner of the address is told how to get
      // in, so a returning user is guided rather than left waiting for a code that never comes.
      await mailer.send(existingAccountEmail(email));
    } else {
      const code = newEmailCode();
      issueCode(db, config, { purpose: "register", email, code });
      await mailer.send(codeEmail(email, code, "register"));
      if (config.devEcho) constant.dev_code = code;
    }
    return c.json(constant);
  });

  app.post("/verify", byIp(limiter, "check", LIMITS.codeCheck), async (c) => {
    const { db, config } = c.get("deps");
    const body = await readBody<{ email?: unknown; code?: unknown }>(c);
    if (typeof body.email !== "string" || typeof body.code !== "string") return c.json({ error: "invalid" }, 400);
    const email = normalizeEmail(body.email);

    const result = checkCode(db, config, limiter, { purpose: "register", email, code: body.code });
    if (!result.ok) return c.json({ error: result.reason === "locked" ? "locked" : "invalid_code" }, 400);
    return c.json({ reg_token: issueGrant(db, config, { kind: "reg", email }) });
  });

  /** Options for a discoverable-credential assertion. No email, so nothing is revealed. */
  app.post("/challenge", byIp(limiter, "assert", LIMITS.assertion), async (c) => {
    const { db, config } = c.get("deps");
    return c.json(await authenticationOptions(db, config, "login"));
  });

  app.post("/login", byIp(limiter, "assert", LIMITS.assertion), async (c) => {
    const { db, config } = c.get("deps");
    const body = await readBody<{ assertion?: AuthenticationResponseJSON }>(c);
    const assertion = body.assertion;
    if (!assertion?.id || !assertion.response?.clientDataJSON) return c.json({ error: "invalid" }, 400);

    const challenge = challengeOf(assertion.response.clientDataJSON);
    if (!challenge || !consumeChallenge(db, challenge, "login")) return c.json({ error: "invalid_challenge" }, 400);

    const cred = db
      .query<
        { id: string; account_id: string; public_key: Uint8Array; counter: number; transports: string | null },
        [string]
      >(`SELECT id, account_id, public_key, counter, transports FROM credentials WHERE id = ?`)
      .get(assertion.id);
    if (!cred) return c.json({ error: "invalid_credential" }, 400);

    const account = db
      .query<{ id: string; email: string; deleted_at: number | null }, [string]>(
        `SELECT id, email, deleted_at FROM accounts WHERE id = ?`,
      )
      .get(cred.account_id);
    if (!account) return c.json({ error: "invalid_credential" }, 400);
    if (account.deleted_at !== null) return c.json({ error: "account_deleted" }, 403);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: cred.transports ? (JSON.parse(cred.transports) as string[]) : undefined,
        },
      });
    } catch {
      return c.json({ error: "invalid_assertion" }, 400);
    }
    if (!verification.verified) return c.json({ error: "invalid_assertion" }, 400);

    const now = Date.now();
    db.query(`UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?`).run(
      verification.authenticationInfo.newCounter,
      now,
      cred.id,
    );

    const tokens = issueSession(db, config, { account_id: account.id, credential_id: cred.id }, now);
    const wrapped = db
      .query<{ wrapped_dek: string | null }, [string]>(`SELECT wrapped_dek FROM wrapped_keys WHERE credential_id = ?`)
      .get(cred.id);
    return c.json({
      ...tokens,
      account: { id: account.id, email: account.email },
      // Null throughout Phase 2: there is no DEK yet (§4.1). Phase 3 fills this in.
      wrapped_dek: wrapped?.wrapped_dek ?? null,
      unlock_methods: unlockMethods(db, account.id),
    });
  });

  app.post("/refresh", async (c) => {
    const { db, config } = c.get("deps");
    const body = await readBody<{ refresh_token?: unknown }>(c);
    if (typeof body.refresh_token !== "string") return c.json({ error: "invalid" }, 400);
    const tokens = rotateRefresh(db, config, body.refresh_token);
    if (!tokens) return c.json({ error: "unauthorized" }, 401);
    return c.json(tokens);
  });

  app.post("/logout", requireSession, async (c) => {
    const { db } = c.get("deps");
    revokeSession(db, c.get("session").id);
    return c.json({ ok: true });
  });

  app.post("/enroll/start", requireSession, async (c) => {
    const { db, config, email: mailer } = c.get("deps");
    const account = c.get("account");
    if (!limiter.take(`issue:email:${account.email}`, LIMITS.codeIssuePerEmail)) return c.json({ ok: true });

    const code = newEmailCode();
    issueCode(db, config, { purpose: "enroll", email: account.email, account_id: account.id, code });
    await mailer.send(codeEmail(account.email, code, "enroll"));
    return c.json(config.devEcho ? { ok: true, dev_code: code } : { ok: true });
  });

  app.post("/enroll/verify", requireSession, byIp(limiter, "check", LIMITS.codeCheck), async (c) => {
    const { db, config } = c.get("deps");
    const account = c.get("account");
    const body = await readBody<{ code?: unknown }>(c);
    if (typeof body.code !== "string") return c.json({ error: "invalid" }, 400);

    const result = checkCode(db, config, limiter, { purpose: "enroll", email: account.email, code: body.code });
    if (!result.ok) return c.json({ error: result.reason === "locked" ? "locked" : "invalid_code" }, 400);
    return c.json({ enroll_token: issueGrant(db, config, { kind: "enroll", account_id: account.id }) });
  });

  return app;
}

/** What can currently unlock this account. Passkeys only until Phase 3 adds the recovery key. */
export function unlockMethods(db: import("bun:sqlite").Database, accountId: string): string[] {
  const n = db
    .query<{ n: number }, [string]>(`SELECT count(*) AS n FROM credentials WHERE account_id = ?`)
    .get(accountId)?.n;
  return (n ?? 0) > 0 ? ["passkey"] : [];
}
