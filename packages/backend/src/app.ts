import { Hono } from "hono";
import { cors } from "hono/cors";
import { SCHEMA_VERSION } from "shared";
import type { AppEnv, Deps } from "./app-env.ts";
import { accountRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { keyRoutes } from "./routes/keys.ts";

/**
 * The relay as a plain Hono app, independent of any socket, so the whole surface is testable
 * through `app.request()`.
 */
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

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error("[relay]", err);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
