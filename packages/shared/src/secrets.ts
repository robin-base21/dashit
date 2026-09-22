export const MIN_POLL_INTERVAL_MS = 5_000;

export const BODY_TYPES = ["json", "text"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods whose stored body is sent. */
export function methodHasBody(method: string | null | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/**
 * Datasource secrets are stored as bytes in `secrets_ciphertext`. Headers and request bodies
 * both routinely carry credentials, so they live together. Without an account there is no DEK
 * and the bytes are plaintext UTF-8 JSON (ARCHITECTURE.md §4.9); Phase 3 encrypts them in place.
 */
export interface DatasourceSecrets {
  headers?: Record<string, string>;
  body?: string;
  body_type?: BodyType;
}

export interface DecodedSecrets {
  headers: Record<string, string>;
  body: string | null;
  body_type: BodyType;
}

export function encodeSecrets(secrets: DatasourceSecrets): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(secrets));
}

export function decodeSecrets(bytes: Uint8Array | null | undefined): DecodedSecrets {
  const empty: DecodedSecrets = { headers: {}, body: null, body_type: "json" };
  if (!bytes || bytes.length === 0) return empty;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DatasourceSecrets;
    return {
      headers: parsed.headers ?? {},
      body: typeof parsed.body === "string" && parsed.body !== "" ? parsed.body : null,
      body_type: BODY_TYPES.includes(parsed.body_type as BodyType) ? (parsed.body_type as BodyType) : "json",
    };
  } catch {
    return empty;
  }
}

/** True when there is anything worth storing. */
export function hasSecrets(secrets: DatasourceSecrets): boolean {
  return Object.keys(secrets.headers ?? {}).length > 0 || !!secrets.body;
}

/** Throws with the parser's message for a JSON body that does not parse; text bodies always pass. */
export function validateBody(body: string | null | undefined, body_type: BodyType): void {
  if (!body || body_type !== "json") return;
  try {
    JSON.parse(body);
  } catch (e) {
    throw new Error(`Body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function bodyContentType(body_type: BodyType): string {
  return body_type === "json" ? "application/json" : "text/plain";
}

/** Parses "Key: Value" lines into a header map; blank lines and lines without a colon are skipped. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function formatHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
