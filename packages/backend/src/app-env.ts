import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import type { EmailSender } from "./email.ts";
import type { RateLimiter } from "./middleware/rate-limit.ts";
import type { Nudge } from "./nudge.ts";
import type { SessionRow } from "./sessions.ts";

export interface AccountRow {
  id: string;
  email: string;
  created_at: number;
  deleted_at: number | null;
}

/** Everything the routes need, passed in rather than imported, so tests can swap any of it. */
export interface Deps {
  db: Database;
  config: Config;
  email: EmailSender;
  limiter: RateLimiter;
  nudge: Nudge;
}

export interface AppEnv {
  Variables: {
    deps: Deps;
    session: SessionRow;
    account: AccountRow;
  };
}
