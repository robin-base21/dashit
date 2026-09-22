let lastMs = -1;
let counter = 0;

/**
 * UUIDv7 (RFC 9562) using Web Crypto; works in browsers, Workers, and Bun.
 * Monotonic within a process: the 12-bit rand_a field is a counter seeded randomly
 * each millisecond, so ids created in the same ms still sort in creation order.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  if (now <= lastMs) {
    now = lastMs;
    counter++;
    if (counter > 0xfff) {
      // Counter overflow: borrow a millisecond, as the RFC permits.
      now = ++lastMs;
      counter = bytes[6]! & 0x07;
    }
  } else {
    lastMs = now;
    counter = ((bytes[6]! << 8) | bytes[7]!) & 0x7ff; // random start, leaves headroom
  }

  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomSiteId(): Uint8Array {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
