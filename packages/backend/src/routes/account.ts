import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import { requireRecentAuth, requireSession } from "../middleware/session.ts";
import { revokeSessionsForAccount } from "../sessions.ts";
import { unlockMethods } from "./auth.ts";

export function accountRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", requireSession, (c) => {
    const { db, config } = c.get("deps");
    const account = c.get("account");
    return c.json({
      account: { id: account.id, email: account.email, created_at: account.created_at },
      unlock_methods: unlockMethods(db, account.id),
      min_schema_version: config.minSchemaVersion,
      // Zero until sync exists — §9 names quotas and usage but never defines them, and inventing
      // numbers before there is anything to measure would only have to be redone.
      usage: { envelopes: 0, bytes: 0 },
    });
  });

  /**
   * Soft-delete with immediate revocation (§9). Sessions and credentials stop working at once, so
   * other devices see `403 account_deleted` on their next call; the 7-day purge job is Phase 3's.
   */
  app.delete("/", requireSession, requireRecentAuth, (c) => {
    const { db } = c.get("deps");
    const accountId = c.get("account").id;
    const now = Date.now();
    db.transaction(() => {
      db.query(`UPDATE accounts SET deleted_at = ? WHERE id = ?`).run(now, accountId);
      revokeSessionsForAccount(db, accountId, now);
      db.query(`DELETE FROM wrapped_keys WHERE account_id = ?`).run(accountId);
      db.query(`DELETE FROM credentials WHERE account_id = ?`).run(accountId);
    })();
    return c.json({ ok: true, purge_after_days: 7 });
  });

  return app;
}
