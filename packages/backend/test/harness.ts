import { Database } from "bun:sqlite";
import { createApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { migrate } from "../src/db.ts";
import { ConsoleEmailSender, type EmailMessage } from "../src/email.ts";
import { RateLimiter } from "../src/middleware/rate-limit.ts";

/** Captures instead of printing, so tests can read the code without watching stdout. */
export class TestEmailSender extends ConsoleEmailSender {
  override async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastCode(): string {
    const body = this.sent.at(-1)?.body ?? "";
    return /(\d{6})/.exec(body)?.[1] ?? "";
  }
}

export interface Harness {
  db: Database;
  config: Config;
  email: TestEmailSender;
  limiter: RateLimiter;
  request(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  json<T>(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: T }>;
}

export function harness(overrides: Partial<Config> = {}): Harness {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const config = loadConfig({ rpId: "localhost", origins: ["http://localhost:5173"], ...overrides });
  const email = new TestEmailSender();
  const limiter = new RateLimiter();
  const app = createApp({ db, config, email, limiter });

  const request = async (path: string, init: RequestInit & { token?: string } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    return app.request(`/api/v1${path}`, { ...init, headers });
  };

  return {
    db,
    config,
    email,
    limiter,
    request,
    async json<T>(path: string, init: RequestInit & { token?: string } = {}) {
      const res = await request(path, init);
      return { status: res.status, body: (await res.json()) as T };
    },
  };
}

export const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
