import { Hono } from "hono";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppEnv } from "../app-env.ts";
import { readBody } from "../body.ts";
import { consumeGrant, peekGrant } from "../codes.ts";
import { newId } from "../crypto.ts";
import { requireRecentAuth, requireSession } from "../middleware/session.ts";
import { issueSession, revokeSessionsForCredential } from "../sessions.ts";
import { challengeOf, consumeChallenge, registrationOptions } from "../webauthn.ts";

export function keyRoutes() {
  const app = new Hono<AppEnv>();

  /**
   * Creation options for a new credential. §9 issues `reg_token`/`enroll_token` but never says
   * where the WebAuthn options come from; this is that route, gated on the same grant.
   */
  app.post("/options", async (c) => {
    const { db, config } = c.get("deps");
    const body = await readBody<{ token?: unknown }>(c);
    if (typeof body.token !== "string") return c.json({ error: "invalid" }, 400);

    const grant = peekGrant(db, body.token);
    if (!grant) return c.json({ error: "invalid_token" }, 400);

    const existing = grant.account_id
      ? db
          .query<{ id: string }, [string]>(`SELECT id FROM credentials WHERE account_id = ?`)
          .all(grant.account_id)
          .map((r) => r.id)
      : [];
    const email =
      grant.email ??
      db.query<{ email: string }, [string]>(`SELECT email FROM accounts WHERE id = ?`).get(grant.account_id!)?.email ??
      "";
    return c.json(await registrationOptions(db, config, { accountId: grant.account_id, email, existingIds: existing }));
  });

  /**
   * Stores a verified credential. With a `reg_token` this is also what creates the account, so the
   * account, credential and wrapped key are written in one transaction — a half-made account with
   * no way in would be unrecoverable.
   */
  app.post("/", async (c) => {
    const { db, config } = c.get("deps");
    const body = await readBody<{
      token?: unknown;
      credential?: RegistrationResponseJSON;
      wrap_method?: unknown;
      wrapped_dek?: unknown;
      prf_capable?: unknown;
      label?: unknown;
    }>(c);
    if (typeof body.token !== "string" || !body.credential?.response?.clientDataJSON) {
      return c.json({ error: "invalid" }, 400);
    }

    const challenge = challengeOf(body.credential.response.clientDataJSON);
    if (!challenge || !consumeChallenge(db, challenge, "registration")) {
      return c.json({ error: "invalid_challenge" }, 400);
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true,
      });
    } catch {
      return c.json({ error: "invalid_credential" }, 400);
    }
    if (!verification.verified) return c.json({ error: "invalid_credential" }, 400);

    const grant = consumeGrant(db, body.token);
    if (!grant) return c.json({ error: "invalid_token" }, 400);

    const cred = verification.registrationInfo.credential;
    const now = Date.now();
    // Phase 2 has no DEK, so this is null; the column and the field exist so Phase 3 fills them
    // in without a contract change.
    const wrappedDek = typeof body.wrapped_dek === "string" ? body.wrapped_dek : null;
    const method = wrappedDek === null ? "none" : "passkey_prf";

    let accountId = grant.account_id;
    try {
      db.transaction(() => {
        if (grant.kind === "reg") {
          accountId = newId();
          db.query(`INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)`).run(accountId, grant.email!, now);
        }
        db.query(
          `INSERT INTO credentials (id, account_id, public_key, counter, transports, label, prf_capable, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cred.id,
          accountId!,
          Buffer.from(cred.publicKey),
          cred.counter,
          JSON.stringify(cred.transports ?? []),
          typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Passkey",
          body.prf_capable === true ? 1 : 0,
          now,
        );
        db.query(
          `INSERT INTO wrapped_keys (credential_id, account_id, method, wrapped_dek, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(cred.id, accountId!, method, wrappedDek, now);
      })();
    } catch (e) {
      // A second live account for one address trips the partial unique index.
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message.includes("UNIQUE") ? "already_registered" : "could_not_store" }, 409);
    }

    const account = db
      .query<{ id: string; email: string }, [string]>(`SELECT id, email FROM accounts WHERE id = ?`)
      .get(accountId!)!;
    const tokens = issueSession(db, config, { account_id: account.id, credential_id: cred.id }, now);
    return c.json({ ...tokens, account: { id: account.id, email: account.email }, credential_id: cred.id }, 201);
  });

  app.get("/", requireSession, (c) => {
    const { db } = c.get("deps");
    const rows = db
      .query<
        { id: string; label: string; prf_capable: number; created_at: number; last_used_at: number | null },
        [string]
      >(
        `SELECT c.id, c.label, c.prf_capable, c.created_at, c.last_used_at
         FROM credentials c WHERE c.account_id = ? ORDER BY c.created_at`,
      )
      .all(c.get("account").id);
    return c.json({
      credentials: rows.map((r) => ({
        id: r.id,
        label: r.label,
        prf_capable: r.prf_capable === 1,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
      })),
    });
  });

  app.patch("/:id", requireSession, async (c) => {
    const { db } = c.get("deps");
    const body = await readBody<{ label?: unknown }>(c);
    if (typeof body.label !== "string" || !body.label.trim()) return c.json({ error: "invalid" }, 400);
    const changes = db
      .query(`UPDATE credentials SET label = ? WHERE id = ? AND account_id = ?`)
      .run(body.label.trim(), c.req.param("id"), c.get("account").id).changes;
    return changes === 1 ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/:id", requireSession, requireRecentAuth, (c) => {
    const { db } = c.get("deps");
    const accountId = c.get("account").id;
    const id = c.req.param("id");

    const owned = db
      .query<{ n: number }, [string, string]>(
        `SELECT count(*) AS n FROM credentials WHERE id = ? AND account_id = ?`,
      )
      .get(id, accountId)?.n;
    if (!owned) return c.json({ error: "not_found" }, 404);

    // §4.5 refuses a deletion that would leave no way in. With recovery deferred to Phase 3, a
    // passkey is the only unlock method, so this is "you cannot delete your last one".
    const total = db
      .query<{ n: number }, [string]>(`SELECT count(*) AS n FROM credentials WHERE account_id = ?`)
      .get(accountId)!.n;
    if (total <= 1) return c.json({ error: "last_unlock_method" }, 409);

    db.transaction(() => {
      revokeSessionsForCredential(db, id);
      db.query(`DELETE FROM wrapped_keys WHERE credential_id = ?`).run(id);
      db.query(`DELETE FROM credentials WHERE id = ? AND account_id = ?`).run(id, accountId);
    })();
    return c.json({ ok: true });
  });

  return app;
}
