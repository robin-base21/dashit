/**
 * Relay configuration. Everything is env-overridable with defaults that work for local dev, so
 * `bun run dev:backend` needs no setup.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export interface Config {
  port: number;
  /** WebAuthn Relying Party id — the registrable domain, no scheme or port. */
  rpId: string;
  rpName: string;
  /** Origins a WebAuthn response may come from. Multiple allows app and relay on separate ports. */
  origins: string[];
  /**
   * Development conveniences. Never true in a production build: it returns email codes in HTTP
   * responses so tests can read them without a mailbox.
   */
  devEcho: boolean;
  /**
   * Multiplies every rate limit. Only ever above 1 in a test environment, where one IP and one
   * long-lived process would otherwise make a test's result depend on how many ran before it.
   */
  rateLimitScale: number;
  /** Oldest client schema the relay will accept. Meaningful once sync lands. */
  minSchemaVersion: number;
  ttl: {
    emailCode: number;
    grant: number;
    challenge: number;
    access: number;
    refresh: number;
    /** How recently a passkey assertion must have happened for a sensitive change. */
    recentAuth: number;
  };
  /** Wrong-code attempts allowed before a code is dead. */
  maxCodeAttempts: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: Number(env("PORT", "3000")),
    rpId: env("DASHIT_RP_ID", "localhost"),
    rpName: env("DASHIT_RP_NAME", "DashIt"),
    origins: env("DASHIT_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim()),
    devEcho: env("DASHIT_DEV_EMAIL_ECHO", "0") === "1",
    rateLimitScale: env("DASHIT_RELAX_RATE_LIMITS", "0") === "1" ? 1000 : 1,
    minSchemaVersion: Number(env("DASHIT_MIN_SCHEMA_VERSION", "1")),
    ttl: {
      emailCode: 15 * MINUTE,
      grant: 15 * MINUTE,
      challenge: 5 * MINUTE,
      access: 15 * MINUTE,
      refresh: 30 * DAY,
      recentAuth: 5 * MINUTE,
    },
    maxCodeAttempts: 5,
    ...overrides,
  };
}
