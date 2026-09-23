import { createApp, websocket } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { ConsoleEmailSender } from "./email.ts";
import { RateLimiter } from "./middleware/rate-limit.ts";
import { Nudge } from "./nudge.ts";

const config = loadConfig();
const app = createApp({
  db: openDb(),
  config,
  email: new ConsoleEmailSender(),
  limiter: new RateLimiter(config.rateLimitScale),
  nudge: new Nudge(),
});

const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket });

console.log(`relay listening on ${server.url}`);
console.log(`  rp id: ${config.rpId}  origins: ${config.origins.join(", ")}`);
if (config.devEcho) console.log("  DEV: email codes are returned in HTTP responses");
