import { Hono } from "hono";
import {
  MAX_ENVELOPE_BYTES,
  MAX_SNAPSHOT_BYTES,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SnapshotBody,
} from "shared";
import type { AppEnv } from "../app-env.ts";
import { readBody } from "../body.ts";
import { requireSession } from "../middleware/session.ts";
import { LIMITS_SYNC } from "../middleware/rate-limit.ts";
import type { Nudge } from "../nudge.ts";

/** §3.5: envelopes stay this long after a snapshot covers them, so a device mid-pull is not cut off. */
export const PRUNE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function syncRoutes(nudge: Nudge) {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession);

  app.post("/push", async (c) => {
    const { db, limiter, config } = c.get("deps");
    const account = c.get("account");
    if (!limiter.take(`push:${account.id}`, LIMITS_SYNC.push)) return c.json({ error: "rate_limited" }, 429);

    const body = await readBody<PushRequest>(c);
    if (
      typeof body.site_id !== "string" ||
      typeof body.payload !== "string" ||
      typeof body.schema_version !== "number" ||
      typeof body.from !== "number" ||
      typeof body.to !== "number"
    ) {
      return c.json({ error: "invalid" }, 400);
    }
    if (body.to <= body.from) return c.json({ error: "empty_range" }, 400);

    const payload = Buffer.from(body.payload, "base64");
    if (payload.byteLength > MAX_ENVELOPE_BYTES) return c.json({ error: "envelope_too_large" }, 413);
    if (!limiter.take(`push-bytes:${account.id}`, LIMITS_SYNC.pushBytes, Date.now(), payload.byteLength)) {
      return c.json({ error: "quota_exceeded" }, 429);
    }
    // A client below the floor would produce envelopes this account's others cannot read.
    if (body.schema_version < config.minSchemaVersion) return c.json({ error: "schema_too_old" }, 409);

    // Bound before the transaction: narrowing from the checks above does not survive into a
    // callback, since TypeScript cannot know the closure runs immediately.
    const { site_id, schema_version, from, to } = body as Required<PushRequest>;
    const now = Date.now();
    let seq = 0;
    db.transaction(() => {
      // The per-account sequence. Taken inside the transaction so two concurrent pushes cannot
      // both read the same high-water mark and collide on the primary key.
      const row = db
        .query<{ next: number }, [string]>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM envelopes WHERE account_id = ?`)
        .get(account.id)!;
      seq = row.next;
      db.query(
        `INSERT INTO envelopes (account_id, seq, site_id, schema_version, from_version, to_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(account.id, seq, site_id, schema_version, from, to, payload, now);
    })();

    // Payload-free: it only says "there is something to pull".
    nudge.publish(account.id, seq, site_id);
    return c.json<PushResponse>({ seq });
  });

  app.get("/pull", (c) => {
    const { db, limiter } = c.get("deps");
    const account = c.get("account");
    if (!limiter.take(`pull:${account.id}`, LIMITS_SYNC.read)) return c.json({ error: "rate_limited" }, 429);

    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
    const siteId = c.req.query("site_id") ?? "";
    if (!Number.isFinite(since) || since < 0) return c.json({ error: "invalid" }, 400);

    const floor = db
      .query<{ oldest_retained_seq: number }, [string]>(`SELECT oldest_retained_seq FROM accounts WHERE id = ?`)
      .get(account.id)!.oldest_retained_seq;
    // Everything the caller still needs has been pruned; only a snapshot can catch them up.
    if (since < floor) return c.json({ error: "gone", oldest_retained_seq: floor }, 410);

    // Own envelopes are filtered here rather than on the client: a site applying its own changes
    // back is harmless but wasteful, and the relay already knows which site asked.
    const rows = db
      .query<
        {
          seq: number;
          site_id: string;
          schema_version: number;
          from_version: number;
          to_version: number;
          payload: Uint8Array;
        },
        [string, number, string, number]
      >(
        `SELECT seq, site_id, schema_version, from_version, to_version, payload
         FROM envelopes WHERE account_id = ? AND seq > ? AND site_id != ? ORDER BY seq LIMIT ?`,
      )
      .all(account.id, since, siteId, limit);

    return c.json<PullResponse>({
      envelopes: rows.map((r) => ({
        v: 1,
        seq: r.seq,
        site_id: r.site_id,
        schema_version: r.schema_version,
        from: r.from_version,
        to: r.to_version,
        payload: Buffer.from(r.payload).toString("base64"),
      })),
      next: rows.length > 0 ? rows[rows.length - 1]!.seq : since,
      oldest_retained_seq: floor,
    });
  });

  app.post("/snapshot", async (c) => {
    const { db, limiter } = c.get("deps");
    const account = c.get("account");
    if (!limiter.take(`snapshot:${account.id}`, LIMITS_SYNC.snapshot)) return c.json({ error: "rate_limited" }, 429);

    const body = await readBody<SnapshotBody>(c);
    if (typeof body.payload !== "string" || typeof body.covers_seq !== "number" || typeof body.schema_version !== "number") {
      return c.json({ error: "invalid" }, 400);
    }
    const payload = Buffer.from(body.payload, "base64");
    if (payload.byteLength > MAX_SNAPSHOT_BYTES) return c.json({ error: "snapshot_too_large" }, 413);

    const { covers_seq, schema_version } = body as Required<SnapshotBody>;
    const now = Date.now();
    db.transaction(() => {
      const existing = db
        .query<{ covers_seq: number }, [string]>(`SELECT covers_seq FROM snapshots WHERE account_id = ?`)
        .get(account.id);
      // Any device may snapshot, so several arrive; the one covering the most is the useful one
      // and an older arrival must not undo it.
      if (existing && existing.covers_seq >= covers_seq) return;
      db.query(
        `INSERT INTO snapshots (account_id, covers_seq, schema_version, payload, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET covers_seq = excluded.covers_seq,
           schema_version = excluded.schema_version, payload = excluded.payload, created_at = excluded.created_at`,
      ).run(account.id, covers_seq, schema_version, payload, now);
    })();

    return c.json({ ok: true, pruned: prune(db, account.id, now) });
  });

  app.get("/snapshot", (c) => {
    const { db, limiter } = c.get("deps");
    const account = c.get("account");
    if (!limiter.take(`pull:${account.id}`, LIMITS_SYNC.read)) return c.json({ error: "rate_limited" }, 429);

    const row = db
      .query<{ covers_seq: number; schema_version: number; payload: Uint8Array }, [string]>(
        `SELECT covers_seq, schema_version, payload FROM snapshots WHERE account_id = ?`,
      )
      .get(account.id);
    if (!row) return c.json({ error: "no_snapshot" }, 404);
    return c.json<SnapshotBody>({
      covers_seq: row.covers_seq,
      schema_version: row.schema_version,
      payload: Buffer.from(row.payload).toString("base64"),
    });
  });

  return app;
}

/**
 * Drops envelopes a snapshot already contains, once the grace period has passed, and raises the
 * account's floor to match. The grace is what stops a device that is mid-pull from being cut off
 * the instant another device snapshots.
 */
export function prune(db: import("bun:sqlite").Database, accountId: string, now = Date.now()): number {
  const snap = db
    .query<{ covers_seq: number; created_at: number }, [string]>(
      `SELECT covers_seq, created_at FROM snapshots WHERE account_id = ?`,
    )
    .get(accountId);
  if (!snap || now - snap.created_at < PRUNE_GRACE_MS) return 0;

  const changes = db
    .query(`DELETE FROM envelopes WHERE account_id = ? AND seq <= ?`)
    .run(accountId, snap.covers_seq).changes;
  db.query(`UPDATE accounts SET oldest_retained_seq = ? WHERE id = ? AND oldest_retained_seq < ?`).run(
    snap.covers_seq,
    accountId,
    snap.covers_seq,
  );
  return changes;
}
