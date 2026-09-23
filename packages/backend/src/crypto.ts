/**
 * Token and code handling. Nothing here is the app's data cryptography — that is Phase 3. These
 * are opaque bearer secrets, stored only as hashes so a dump of the relay database does not hand
 * anyone a working session.
 */

/** 32 bytes of randomness, base64url. Used for access, refresh and grant tokens. */
export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** A 6-digit code, uniformly distributed (rejection sampling, not a biased modulo). */
export function newEmailCode(): string {
  const limit = 1_000_000;
  const max = Math.floor(0xffff_ffff / limit) * limit;
  let n: number;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  } while (n >= max);
  return String(n % limit).padStart(6, "0");
}

/** Length-independent comparison, so a mismatch reveals nothing through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare a fixed-size digest rather than the raw values, so unequal lengths cannot short-circuit.
  const ad = new Bun.CryptoHasher("sha256").update(ab).digest();
  const bd = new Bun.CryptoHasher("sha256").update(bb).digest();
  let diff = 0;
  for (let i = 0; i < ad.length; i++) diff |= ad[i]! ^ bd[i]!;
  return diff === 0 && ab.length === bb.length;
}

/** Addresses are compared case-insensitively; store and look up the normalized form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
