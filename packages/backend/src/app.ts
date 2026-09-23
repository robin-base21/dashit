import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { SCHEMA_VERSION } from "shared";
import type { AppEnv, Deps } from "./app-env.ts";
import { accountRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { keyRoutes } from "./routes/keys.ts";
import { syncRoutes } from "./routes/sync.ts";
import { sessionByAccess } from "./sessions.ts";

/**
 * The relay as a plain Hono app, independent of any socket, so the whole surface is testable
 * through `app.request()`.
 */
const { upgradeWebSocket, websocket } = createBunWebSocket();

/** Handed to `Bun.serve` so the nudge socket can upgrade. */
export { websocket };

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  // The app is served from its own origin, and WebAuthn ceremonies need credentialed requests.
  app.use(
    "*",
    cors({ origin: deps.config.origins, credentials: true, allowHeaders: ["Content-Type", "Authorization"] }),
  );

  app.get("/api/v1/health", (c) =>
    c.json({ ok: true, schema_version: SCHEMA_VERSION, min_schema_version: deps.config.minSchemaVersion }),
  );
  app.route("/api/v1/auth", authRoutes(deps.limiter));
  app.route("/api/v1/keys", keyRoutes());
  app.route("/api/v1/account", accountRoutes());
  app.route("/api/v1/sync", syncRoutes(deps.nudge));

  /**
   * The live nudge (§3.4). Mounted here rather than inside `syncRoutes` because it cannot use the
   * bearer middleware: a browser cannot set headers on a WebSocket, so §4.7 puts the access token
   * in the subprotocol instead.
   */
  app.get(
    "/api/v1/subscribe",
    upgradeWebSocket((c) => {
      const protocols = (c.req.header("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
      const token = protocols[1] ?? "";
      const siteId = c.req.query("site_id") ?? "";
      const session = token ? sessionByAccess(deps.db, token) : null;
      let unsubscribe: (() => void) | null = null;

      return {
        onOpen(_event, ws) {
          if (!session) {
            ws.close(1008, "unauthorized");
            return;
          }
          unsubscribe = deps.nudge.subscribe(session.account_id, {
            siteId,
            send: (data) => ws.send(data),
          });
        },
        onClose() {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error("[relay]", err);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
