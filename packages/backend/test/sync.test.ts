import { beforeEach, describe, expect, test } from "bun:test";
import { harness, type Harness } from "./harness.ts";
import { newId } from "../src/crypto.ts";
import { issueSession } from "../src/sessions.ts";
import { PRUNE_GRACE_MS, prune } from "../src/routes/sync.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** Two devices on one account. The relay never parses a payload, so any bytes will do. */
function account(h: Harness, sites = 2) {
  const accountId = newId();
  h.db.query(`INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)`).run(accountId, `${accountId}@t.test`, 1);
  const tokens = Array.from({ length: sites }, () =>
    issueSession(h.db, h.config, { account_id: accountId, credential_id: null }),
  );
  return { accountId, tokens };
}

const payload = (text: string) => Buffer.from(text).toString("base64");

function push(h: Harness, token: string, over: Partial<Record<string, unknown>> = {}) {
  return h.json<{ seq?: number; error?: string }>("/sync/push", {
    method: "POST",
    token,
    body: JSON.stringify({ v: 1, site_id: "site-a", schema_version: 4, from: 0, to: 1, payload: payload("x"), ...over }),
  });
}

describe("push", () => {
  test("assigns a strictly increasing seq per account", async () => {
    const { tokens } = account(h);
    expect((await push(h, tokens[0]!.access_token)).body.seq).toBe(1);
    expect((await push(h, tokens[0]!.access_token, { from: 1, to: 2 })).body.seq).toBe(2);
    expect((await push(h, tokens[1]!.access_token, { site_id: "site-b", from: 0, to: 5 })).body.seq).toBe(3);
  });

  test("accounts have independent sequences", async () => {
    const a = account(h, 1);
    const b = account(h, 1);
    expect((await push(h, a.tokens[0]!.access_token)).body.seq).toBe(1);
    expect((await push(h, b.tokens[0]!.access_token)).body.seq).toBe(1);
  });

  test("refuses an empty or inverted range", async () => {
    const { tokens } = account(h, 1);
    expect((await push(h, tokens[0]!.access_token, { from: 5, to: 5 })).body.error).toBe("empty_range");
    expect((await push(h, tokens[0]!.access_token, { from: 5, to: 1 })).body.error).toBe("empty_range");
  });

  test("refuses an envelope over the size cap", async () => {
    const { tokens } = account(h, 1);
    const big = Buffer.alloc(1024 * 1024 + 1).toString("base64");
    const res = await push(h, tokens[0]!.access_token, { payload: big });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("envelope_too_large");
  });

  test("refuses a client below the schema floor", async () => {
    const { tokens } = account(h, 1);
    const res = await push(h, tokens[0]!.access_token, { schema_version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("schema_too_old");
  });

  test("needs a session", async () => {
    expect((await h.request("/sync/push", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("pull", () => {
  test("returns other sites' envelopes and never your own", async () => {
    const { tokens } = account(h);
    await push(h, tokens[0]!.access_token, { site_id: "site-a", payload: payload("from-a") });
    await push(h, tokens[1]!.access_token, { site_id: "site-b", payload: payload("from-b") });

    const { body } = await h.json<{ envelopes: { site_id: string; payload: string }[]; next: number }>(
      "/sync/pull?since=0&site_id=site-a",
      { token: tokens[0]!.access_token },
    );
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0]!.site_id).toBe("site-b");
    // The payload survives the round trip untouched — the relay never looks inside.
    expect(Buffer.from(body.envelopes[0]!.payload, "base64").toString()).toBe("from-b");
    expect(body.next).toBe(2);
  });

  test("resumes from a watermark and reports it when there is nothing new", async () => {
    const { tokens } = account(h);
    await push(h, tokens[1]!.access_token, { site_id: "site-b" });
    const first = await h.json<{ next: number }>("/sync/pull?since=0&site_id=site-a", { token: tokens[0]!.access_token });
    const second = await h.json<{ envelopes: unknown[]; next: number }>(
      `/sync/pull?since=${first.body.next}&site_id=site-a`,
      { token: tokens[0]!.access_token },
    );
    expect(second.body.envelopes).toHaveLength(0);
    expect(second.body.next).toBe(first.body.next);
  });

  test("honours the limit", async () => {
    const { tokens } = account(h);
    for (let i = 0; i < 5; i++) await push(h, tokens[1]!.access_token, { site_id: "site-b", from: i, to: i + 1 });
    const { body } = await h.json<{ envelopes: unknown[] }>("/sync/pull?since=0&limit=2&site_id=site-a", {
      token: tokens[0]!.access_token,
    });
    expect(body.envelopes).toHaveLength(2);
  });

  test("a since below the retained floor is gone, not silently incomplete", async () => {
    const { accountId, tokens } = account(h);
    h.db.query(`UPDATE accounts SET oldest_retained_seq = 10 WHERE id = ?`).run(accountId);
    const res = await h.json<{ error: string; oldest_retained_seq: number }>("/sync/pull?since=3&site_id=site-a", {
      token: tokens[0]!.access_token,
    });
    expect(res.status).toBe(410);
    expect(res.body.oldest_retained_seq).toBe(10);
  });
});

describe("snapshots", () => {
  const snapshot = (h: Harness, token: string, covers_seq: number, text = "snap") =>
    h.json<{ ok?: boolean; error?: string }>("/sync/snapshot", {
      method: "POST",
      token,
      body: JSON.stringify({ covers_seq, schema_version: 4, payload: payload(text) }),
    });

  test("stores one per account and serves it back", async () => {
    const { tokens } = account(h, 1);
    expect((await snapshot(h, tokens[0]!.access_token, 7)).status).toBe(200);
    const { body } = await h.json<{ covers_seq: number; payload: string }>("/sync/snapshot", {
      token: tokens[0]!.access_token,
    });
    expect(body.covers_seq).toBe(7);
    expect(Buffer.from(body.payload, "base64").toString()).toBe("snap");
  });

  test("an older snapshot never displaces a newer one", async () => {
    const { tokens } = account(h, 1);
    await snapshot(h, tokens[0]!.access_token, 20, "newer");
    await snapshot(h, tokens[0]!.access_token, 5, "older");
    const { body } = await h.json<{ covers_seq: number; payload: string }>("/sync/snapshot", {
      token: tokens[0]!.access_token,
    });
    expect(body.covers_seq).toBe(20);
    expect(Buffer.from(body.payload, "base64").toString()).toBe("newer");
  });

  test("absent until one is made", async () => {
    const { tokens } = account(h, 1);
    expect((await h.request("/sync/snapshot", { token: tokens[0]!.access_token })).status).toBe(404);
  });
});

describe("pruning", () => {
  test("keeps everything until the grace period has passed", async () => {
    const { accountId, tokens } = account(h);
    for (let i = 0; i < 3; i++) await push(h, tokens[0]!.access_token, { from: i, to: i + 1 });
    h.db
      .query(`INSERT INTO snapshots (account_id, covers_seq, schema_version, payload, created_at) VALUES (?,?,?,?,?)`)
      .run(accountId, 3, 4, Buffer.from("s"), Date.now());

    expect(prune(h.db, accountId)).toBe(0);
    expect(h.db.query(`SELECT count(*) AS n FROM envelopes`).get()).toMatchObject({ n: 3 });
  });

  test("drops covered envelopes afterwards and raises the floor", async () => {
    const { accountId, tokens } = account(h);
    for (let i = 0; i < 4; i++) await push(h, tokens[0]!.access_token, { from: i, to: i + 1 });
    const old = Date.now() - PRUNE_GRACE_MS - 1;
    h.db
      .query(`INSERT INTO snapshots (account_id, covers_seq, schema_version, payload, created_at) VALUES (?,?,?,?,?)`)
      .run(accountId, 3, 4, Buffer.from("s"), old);

    expect(prune(h.db, accountId)).toBe(3);
    // The uncovered envelope stays; the floor now makes an older `since` a 410.
    expect(h.db.query(`SELECT count(*) AS n FROM envelopes`).get()).toMatchObject({ n: 1 });
    expect(h.db.query<{ oldest_retained_seq: number }, [string]>(
      `SELECT oldest_retained_seq FROM accounts WHERE id = ?`,
    ).get(accountId)).toMatchObject({ oldest_retained_seq: 3 });
  });

  test("never lowers the floor", async () => {
    const { accountId } = account(h, 1);
    h.db.query(`UPDATE accounts SET oldest_retained_seq = 50 WHERE id = ?`).run(accountId);
    h.db
      .query(`INSERT INTO snapshots (account_id, covers_seq, schema_version, payload, created_at) VALUES (?,?,?,?,?)`)
      .run(accountId, 3, 4, Buffer.from("s"), Date.now() - PRUNE_GRACE_MS - 1);
    prune(h.db, accountId);
    expect(h.db.query<{ oldest_retained_seq: number }, [string]>(
      `SELECT oldest_retained_seq FROM accounts WHERE id = ?`,
    ).get(accountId)).toMatchObject({ oldest_retained_seq: 50 });
  });
});

describe("limits", () => {
  test("push is capped per account", async () => {
    const { tokens } = account(h, 1);
    for (let i = 0; i < 60; i++) expect((await push(h, tokens[0]!.access_token, { from: i, to: i + 1 })).status).toBe(200);
    expect((await push(h, tokens[0]!.access_token, { from: 99, to: 100 })).status).toBe(429);
  });

  test("the byte quota counts payload size, not requests", async () => {
    const { tokens } = account(h, 1);
    // Just under the 1 MiB per-envelope cap, so it is the hourly byte quota being tested and not
    // the size limit: eight fit inside 8 MiB, the ninth does not.
    const chunk = Buffer.alloc(1_000_000).toString("base64");
    for (let i = 0; i < 8; i++) {
      expect((await push(h, tokens[0]!.access_token, { from: i, to: i + 1, payload: chunk })).status, `push ${i}`).toBe(200);
    }
    const ninth = await push(h, tokens[0]!.access_token, { from: 8, to: 9, payload: chunk });
    expect(ninth.status).toBe(429);
    expect(ninth.body.error).toBe("quota_exceeded");
  });
});

describe("nudge", () => {
  test("a push announces the new seq to the other site only", async () => {
    const { accountId, tokens } = account(h, 1);
    const seen: { site: string; data: string }[] = [];
    const stop = h.nudge.subscribe(accountId, { siteId: "site-b", send: (d) => seen.push({ site: "site-b", data: d }) });
    h.nudge.subscribe(accountId, { siteId: "site-a", send: (d) => seen.push({ site: "site-a", data: d }) });

    await push(h, tokens[0]!.access_token, { site_id: "site-a" });

    // The author is not told about its own push.
    expect(seen).toEqual([{ site: "site-b", data: JSON.stringify({ seq: 1 }) }]);
    stop();
    expect(h.nudge.count(accountId)).toBe(1);
  });
});
