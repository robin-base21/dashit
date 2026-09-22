export const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * Datasource secrets are stored as bytes in `secrets_ciphertext`. Without an account there is no
 * DEK, so the bytes are plaintext UTF-8 JSON (ARCHITECTURE.md §4.9); Phase 3 encrypts them in place.
 */
export interface DatasourceSecrets {
  headers?: Record<string, string>;
}

export function encodeSecrets(secrets: DatasourceSecrets): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(secrets));
}

export function decodeSecrets(bytes: Uint8Array | null | undefined): { headers: Record<string, string> } {
  if (!bytes || bytes.length === 0) return { headers: {} };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DatasourceSecrets;
    return { headers: parsed.headers ?? {} };
  } catch {
    return { headers: {} };
  }
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
