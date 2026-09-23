import { beforeEach, describe, expect, test } from "bun:test";
import { harness, post, type Harness } from "./harness.ts";
import { newId } from "../src/crypto.ts";
import { issueSession } from "../src/sessions.ts";

let h: Harness;
beforeEach(() => {
  h = harness({ devEcho: true });
});

/**
 * Seeds an account and credentials directly. The WebAuthn ceremony that would normally create
 * these is covered by the Playwright virtual-authenticator test; everything around it is here.
 */
function seed(h: Harness, credentials = 1, authedAt = Date.now(), email = "sam@example.test") {
  const accountId = newId();
  const now = Date.now();
  h.db.query(`INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)`).run(accountId, email, now);
  const ids: string[] = [];
  for (let i = 0; i < credentials; i++) {
    const id = `cred-${i}-${accountId}`;
    ids.push(id);
    h.db
      .query(
        `INSERT INTO credentials (id, account_id, public_key, counter, transports, label, prf_capable, created_at)
         VALUES (?, ?, ?, 0, '[]', ?, ?, ?)`,
      )
      .run(id, accountId, Buffer.from([1]), `Passkey ${i + 1}`, i === 0 ? 1 : 0, now);
    h.db
      .query(`INSERT INTO wrapped_keys (credential_id, account_id, method, wrapped_dek, created_at) VALUES (?,?,?,?,?)`)
      .run(id, accountId, "none", null, now);
  }
  const tokens = issueSession(h.db, h.config, { account_id: accountId, credential_id: ids[0]! }, now);
  if (authedAt !== now) h.db.query(`UPDATE sessions SET authed_at = ? WHERE account_id = ?`).run(authedAt, accountId);
  return { accountId, ids, tokens };
}

describe("listing and labelling", () => {
  test("lists this account's credentials with their PRF capability", async () => {
    const { tokens } = seed(h, 2);
    const { body } = await h.json<{ credentials: { id: string; label: string; prf_capable: boolean }[] }>("/keys", {
      token: tokens.access_token,
    });
    expect(body.credentials).toHaveLength(2);
    expect(body.credentials[0]).toMatchObject({ label: "Passkey 1", prf_capable: true });
    expect(body.credentials[1]).toMatchObject({ label: "Passkey 2", prf_capable: false });
  });

  test("renames a credential, but not someone else's", async () => {
    const mine = seed(h, 1);
    const theirs = seed(h, 1, Date.now(), "other@example.test");
    expect(
      (await h.request(`/keys/${mine.ids[0]}`, { method: "PATCH", body: JSON.stringify({ label: "Laptop" }), token: mine.tokens.access_token })).status,
    ).toBe(200);
    expect(
      (await h.request(`/keys/${theirs.ids[0]}`, { method: "PATCH", body: JSON.stringify({ label: "Nope" }), token: mine.tokens.access_token })).status,
    ).toBe(404);
  });
});

describe("deleting a credential", () => {
  test("refuses to remove the last unlock method", async () => {
    const { tokens, ids } = seed(h, 1);
    const res = await h.json<{ error: string }>(`/keys/${ids[0]}`, { method: "DELETE", token: tokens.access_token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("last_unlock_method");
  });

  test("removes one when another remains, revoking its sessions", async () => {
    const { tokens, ids, accountId } = seed(h, 2);
    // A session bound to the credential about to be deleted.
    const doomed = issueSession(h.db, h.config, { account_id: accountId, credential_id: ids[1]! });

    expect((await h.request(`/keys/${ids[1]}`, { method: "DELETE", token: tokens.access_token })).status).toBe(200);
    expect((await h.request("/account", { token: doomed.access_token })).status).toBe(401);
    // The caller's own session, on the surviving credential, still works.
    expect((await h.request("/account", { token: tokens.access_token })).status).toBe(200);
  });

  test("removing the credential you signed in with ends your own session", async () => {
    // §4.5 revokes the sessions of a deleted credential, and the caller's is one of them. The
    // delete succeeds and the very next call is unauthorized — which the UI has to expect.
    const { tokens, ids } = seed(h, 2);
    expect((await h.request(`/keys/${ids[0]}`, { method: "DELETE", token: tokens.access_token })).status).toBe(200);
    expect((await h.request("/keys", { token: tokens.access_token })).status).toBe(401);
  });

  test("needs a recent assertion", async () => {
    const stale = Date.now() - 10 * 60_000;
    const { tokens, ids } = seed(h, 2, stale);
    const res = await h.json<{ error: string }>(`/keys/${ids[1]}`, { method: "DELETE", token: tokens.access_token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("recent_auth_required");
  });
});

describe("account", () => {
  test("reports the account, its unlock methods and the schema floor", async () => {
    const { tokens, accountId } = seed(h, 1);
    const { body } = await h.json<{
      account: { id: string; email: string };
      unlock_methods: string[];
      min_schema_version: number;
    }>("/account", { token: tokens.access_token });
    expect(body.account).toMatchObject({ id: accountId, email: "sam@example.test" });
    expect(body.unlock_methods).toEqual(["passkey"]);
    expect(body.min_schema_version).toBe(h.config.minSchemaVersion);
  });

  test("deletion revokes everything and then reads as gone, not as signed out", async () => {
    const { tokens, accountId } = seed(h, 2);
    const other = issueSession(h.db, h.config, { account_id: accountId, credential_id: null });

    expect((await h.request("/account", { method: "DELETE", token: tokens.access_token })).status).toBe(200);

    // A revoked token is merely unauthorized; the distinction clients need is on a live session.
    const revived = issueSession(h.db, h.config, { account_id: accountId, credential_id: null });
    const res = await h.json<{ error: string }>("/account", { token: revived.access_token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_deleted");

    expect((await h.request("/account", { token: other.access_token })).status).toBe(401);
    expect(h.db.query(`SELECT count(*) AS n FROM credentials`).get()).toMatchObject({ n: 0 });
  });

  test("the address is released for re-registration after deletion", async () => {
    const { tokens } = seed(h, 1);
    await h.request("/account", { method: "DELETE", token: tokens.access_token });
    // The partial unique index only covers live accounts, so the address can sign up again.
    const again = await h.json<{ dev_code?: string }>("/auth/register", post({ email: "sam@example.test" }));
    expect(again.body.dev_code).toMatch(/^\d{6}$/);
  });
});
