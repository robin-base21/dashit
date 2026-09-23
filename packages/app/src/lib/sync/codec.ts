import { decode, encode } from "cbor-x";
import type { Changeset } from "shared";

/**
 * Changeset ↔ bytes.
 *
 * CBOR because a changeset row carries `pk` and `site_id` as raw bytes, which JSON cannot hold
 * without base64-ing each field. Phase 3 feeds exactly these bytes to AES-GCM instead of sending
 * them directly — the payload *format* does not change, only whether it is wrapped.
 */
export function encodeChangeset(rows: Changeset): Uint8Array {
  return encode(rows);
}

export function decodeChangeset(bytes: Uint8Array): Changeset {
  return decode(bytes) as Changeset;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunked: spreading a large array into String.fromCharCode blows the call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function fromBase64(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Rough encoded size of one changeset row, for chunking. An estimate is enough: the cap exists to
 * keep envelopes small, and the relay rejects anything genuinely oversized.
 */
export function rowSize(row: Changeset[number]): number {
  const val = row.val;
  const valSize =
    val === null ? 1 : typeof val === "string" ? val.length : val instanceof Uint8Array ? val.byteLength : 8;
  return row.table.length + row.cid.length + row.pk.byteLength + row.site_id.byteLength + valSize + 48;
}
