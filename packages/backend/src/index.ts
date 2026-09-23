import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { ConsoleEmailSender } from "./email.ts";
import { RateLimiter } from "./middleware/rate-limit.ts";

const config = loadConfig();
const app = createApp({
  db: openDb(),
  config,
  email: new ConsoleEmailSender(),
  limiter: new RateLimiter(config.rateLimitScale),
});

const server = Bun.serve({ port: config.port, fetch: app.fetch });

console.log(`relay listening on ${server.url}`);
console.log(`  rp id: ${config.rpId}  origins: ${config.origins.join(", ")}`);
if (config.devEcho) console.log("  DEV: email codes are returned in HTTP responses");
