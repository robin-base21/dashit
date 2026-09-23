import { beforeEach, describe, expect, test } from "bun:test";
import { harness, post, type Harness } from "./harness.ts";
import { issueSession } from "../src/sessions.ts";
import { newId } from "../src/crypto.ts";

let h: Harness;
beforeEach(() => {
  h = harness({ devEcho: true });
});

/** Seeds an account with credentials directly: the WebAuthn ceremony is covered by e2e. */
function seedAccount(h: Harness, email = "sam@example.test", credentials = 1) {
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
         VALUES (?, ?, ?, 0, '[]', ?, 1, ?)`,
      )
      .run(id, accountId, Buffer.from([1, 2, 3]), `Passkey ${i + 1}`, now);
    h.db
      .query(`INSERT INTO wrapped_keys (credential_id, account_id, method, wrapped_dek, created_at) VALUES (?,?,?,?,?)`)
      .run(id, accountId, "none", null, now);
  }
  const tokens = issueSession(h.db, h.config, { account_id: accountId, credential_id: ids[0] ?? null }, now);
  return { accountId, ids, tokens };
}

describe("registration codes", () => {
  test("issues a code and exchanges it for a reg token", async () => {
    const reg = await h.json<{ dev_code?: string }>("/auth/register", post({ email: "Sam@Example.test" }));
    expect(reg.status).toBe(200);
    expect(reg.body.dev_code).toMatch(/^\d{6}$/);

    // The address was normalized on the way in, so the lowercase form verifies.
    const ver = await h.json<{ reg_token?: string }>(
      "/auth/verify",
      post({ email: "sam@example.test", code: reg.body.dev_code }),
    );
    expect(ver.status).toBe(200);
    expect(ver.body.reg_token).toBeTruthy();
  });

  test("a code is single-use", async () => {
    const reg = await h.json<{ dev_code: string }>("/auth/register", post({ email: "a@b.test" }));
    await h.request("/auth/verify", post({ email: "a@b.test", code: reg.body.dev_code }));
    const second = await h.json<{ error: string }>("/auth/verify", post({ email: "a@b.test", code: reg.body.dev_code }));
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_code");
  });

  test("a wrong code burns an attempt and the fifth kills the code", async () => {
    const reg = await h.json<{ dev_code: string }>("/auth/register", post({ email: "a@b.test" }));
    for (let i = 0; i < 5; i++) {
      const bad = await h.json<{ error: string }>("/auth/verify", post({ email: "a@b.test", code: "000000" }));
      expect(bad.status, `attempt ${i + 1}`).toBe(400);
    }
    // The IP limit and the attempt counter both allow 5, so they trip together. Clear the limiter
    // to prove it is the *code* that is spent, not just the bucket.
    h.limiter.reset();
    const good = await h.json<{ error: string }>("/auth/verify", post({ email: "a@b.test", code: reg.body.dev_code }));
    expect(good.status).toBe(400);
    expect(good.body.error).toBe("invalid_code");
  });

  test("verify is rate limited per IP at the documented threshold", async () => {
    await h.request("/auth/register", post({ email: "a@b.test" }));
    for (let i = 0; i < 5; i++) {
      expect((await h.request("/auth/verify", post({ email: "a@b.test", code: "000000" }))).status).toBe(400);
    }
    expect((await h.request("/auth/verify", post({ email: "a@b.test", code: "000000" }))).status).toBe(429);
  });

  test("code issuance is rate limited per address without revealing it", async () => {
    // Three per hour per address (§9); the fourth still answers 200 so nothing is leaked.
    for (let i = 0; i < 3; i++) {
      const r = await h.json<{ dev_code?: string }>("/auth/register", post({ email: "burst@b.test" }));
      expect(r.body.dev_code).toMatch(/^\d{6}$/);
    }
    const fourth = await h.json<{ dev_code?: string }>("/auth/register", post({ email: "burst@b.test" }));
    expect(fourth.status).toBe(200);
    expect(fourth.body.dev_code).toBeUndefined();
    expect(h.email.sent).toHaveLength(3);
  });

  test("register answers identically for a known and an unknown address", async () => {
    // Without the dev echo the two responses must be byte-identical: the response is the only
    // thing an attacker sees, so anything that differs is an account-existence oracle.
    const plain = harness();
    plain.db
      .query(`INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
      .run(newId(), "taken@example.test", Date.now());

    const known = await plain.request("/auth/register", post({ email: "taken@example.test" }));
    const unknown = await plain.request("/auth/register", post({ email: "free@example.test" }));

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  test("a known address is told how to sign in instead, and gets no code", async () => {
    seedAccount(h, "taken@example.test");
    const known = await h.json<{ dev_code?: string }>("/auth/register", post({ email: "taken@example.test" }));

    expect(known.status).toBe(200);
    expect(known.body.dev_code).toBeUndefined();
    const mail = h.email.sent.at(-1)!;
    expect(mail.to).toBe("taken@example.test");
    expect(mail.subject).toMatch(/already have/i);
    // It points at the route that actually works, including from another device.
    expect(mail.body).toMatch(/passkey/i);
    expect(mail.body).toMatch(/another device/i);
    // And no code is anywhere in it.
    expect(mail.body).not.toMatch(/\d{6}/);
  });

  test("rejects a malformed address before touching storage", async () => {
    expect((await h.request("/auth/register", post({ email: "nope" }))).status).toBe(400);
    expect((await h.request("/auth/register", post({}))).status).toBe(400);
  });
});

describe("enrolling another passkey", () => {
  test("code, then token, then creation options for the existing account", async () => {
    const { tokens, accountId } = seedAccount(h);

    const start = await h.json<{ dev_code?: string }>("/auth/enroll/start", {
      ...post({}),
      token: tokens.access_token,
    });
    expect(start.status).toBe(200);
    expect(start.body.dev_code).toMatch(/^\d{6}$/);
    expect(h.email.sent.at(-1)!.subject).toMatch(/passkey/i);

    const verify = await h.json<{ enroll_token: string }>("/auth/enroll/verify", {
      ...post({ code: start.body.dev_code }),
      token: tokens.access_token,
    });
    expect(verify.status).toBe(200);

    // The grant is bound to the account, so the options exclude the credential already on it —
    // otherwise the authenticator would happily make a duplicate.
    const options = await h.json<{ challenge: string; excludeCredentials: { id: string }[] }>(
      "/keys/options",
      post({ token: verify.body.enroll_token }),
    );
    expect(options.status).toBe(200);
    expect(options.body.excludeCredentials).toHaveLength(1);

    const stored = h.db
      .query<{ kind: string; account_id: string }, [string]>(
        `SELECT kind, account_id FROM challenges WHERE challenge = ?`,
      )
      .get(options.body.challenge);
    expect(stored).toMatchObject({ kind: "registration", account_id: accountId });
  });

  test("enrolment needs a session", async () => {
    expect((await h.request("/auth/enroll/start", post({}))).status).toBe(401);
  });

  test("a wrong enrolment code does not yield a token", async () => {
    const { tokens } = seedAccount(h);
    await h.request("/auth/enroll/start", { ...post({}), token: tokens.access_token });
    const bad = await h.json<{ error: string }>("/auth/enroll/verify", {
      ...post({ code: "000000" }),
      token: tokens.access_token,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_code");
  });

  test("a registration grant cannot be reused to add a second credential", async () => {
    // Grants are single-use; spending one must not leave it able to mint another credential.
    const reg = await h.json<{ dev_code: string }>("/auth/register", post({ email: "new@example.test" }));
    const { body } = await h.json<{ reg_token: string }>(
      "/auth/verify",
      post({ email: "new@example.test", code: reg.body.dev_code }),
    );
    const { consumeGrant, peekGrant } = await import("../src/codes.ts");
    expect(consumeGrant(h.db, body.reg_token)).toMatchObject({ kind: "reg", email: "new@example.test" });
    expect(peekGrant(h.db, body.reg_token)).toBeNull();
    expect((await h.request("/keys/options", post({ token: body.reg_token }))).status).toBe(400);
  });
});

describe("challenges", () => {
  test("a challenge is stored and single-use", async () => {
    const { body } = await h.json<{ challenge: string }>("/auth/challenge", { method: "POST" });
    expect(body.challenge).toBeTruthy();

    const row = h.db
      .query<{ kind: string; consumed_at: number | null }, [string]>(
        `SELECT kind, consumed_at FROM challenges WHERE challenge = ?`,
      )
      .get(body.challenge);
    expect(row).toMatchObject({ kind: "login", consumed_at: null });

    const { consumeChallenge } = await import("../src/webauthn.ts");
    expect(consumeChallenge(h.db, body.challenge, "login")).toBe(true);
    expect(consumeChallenge(h.db, body.challenge, "login")).toBe(false);
  });

  test("login refuses an assertion whose challenge was never issued", async () => {
    const clientDataJSON = Buffer.from(JSON.stringify({ challenge: "never-issued" })).toString("base64url");
    const res = await h.json<{ error: string }>(
      "/auth/login",
      post({ assertion: { id: "x", response: { clientDataJSON } } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_challenge");
  });
});

describe("sessions", () => {
  test("refresh rotates and retires the old token", async () => {
    const { tokens } = seedAccount(h);
    const first = await h.json<{ access_token: string; refresh_token: string }>(
      "/auth/refresh",
      post({ refresh_token: tokens.refresh_token }),
    );
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await h.request("/auth/refresh", post({ refresh_token: tokens.refresh_token }));
    expect(replay.status).toBe(401);

    // The rotated access token works.
    expect((await h.request("/account", { token: first.body.access_token })).status).toBe(200);
  });

  test("logout revokes the session", async () => {
    const { tokens } = seedAccount(h);
    expect((await h.request("/auth/logout", { ...post({}), token: tokens.access_token })).status).toBe(200);
    expect((await h.request("/account", { token: tokens.access_token })).status).toBe(401);
  });

  test("a missing or unknown bearer token is unauthorized", async () => {
    expect((await h.request("/account")).status).toBe(401);
    expect((await h.request("/account", { token: "made-up" })).status).toBe(401);
  });
});
