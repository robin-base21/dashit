import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import { hasRecentAuth, sessionByAccess } from "../sessions.ts";

/**
 * Resolves a bearer access token to a live account. A deleted account gets `403 account_deleted`
 * during its grace period rather than a 401, so clients can tell "signed out" from "gone" and
 * offer to wipe (§9).
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const { db } = c.get("deps");
  const session = sessionByAccess(db, token);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const account = db
    .query<{ id: string; email: string; created_at: number; deleted_at: number | null }, [string]>(
      `SELECT id, email, created_at, deleted_at FROM accounts WHERE id = ?`,
    )
    .get(session.account_id);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  if (account.deleted_at !== null) return c.json({ error: "account_deleted" }, 403);

  c.set("session", session);
  c.set("account", account);
  await next();
};

/** For changes §9 gates on a fresh assertion: deleting a credential, deleting the account. */
export const requireRecentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { config } = c.get("deps");
  if (!hasRecentAuth(c.get("session"), config)) return c.json({ error: "recent_auth_required" }, 403);
  await next();
};
