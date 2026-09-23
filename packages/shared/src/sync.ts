/**
 * The sync wire format (ARCHITECTURE.md §3.2–§3.3).
 *
 * The payload is CBOR because a changeset row carries `pk` and `site_id` as raw bytes, which JSON
 * cannot represent without base64. The relay never parses it — it stores an opaque blob beside the
 * header it was handed — so Phase 3 changes one thing only: the payload becomes ciphertext instead
 * of plaintext CBOR. What the bytes are *of* never changes.
 */

/** Envelope header. Everything here is visible to the relay; the payload is not. */
export interface EnvelopeHeader {
  v: 1;
  site_id: string;
  schema_version: number;
  /** Exclusive lower and inclusive upper `db_version` bound of the rows inside. */
  from: number;
  to: number;
}

export interface PushRequest extends EnvelopeHeader {
  /** base64 of cbor(changeset), or of the ciphertext once Phase 3 lands. */
  payload: string;
}

export interface PushResponse {
  seq: number;
}

export interface PulledEnvelope extends EnvelopeHeader {
  seq: number;
  payload: string;
}

export interface PullResponse {
  envelopes: PulledEnvelope[];
  /** The highest seq in this batch, or the caller's `since` when empty. */
  next: number;
  /** A `since` below this is gone; the client must re-bootstrap from a snapshot. */
  oldest_retained_seq: number;
}

export interface SnapshotBody {
  covers_seq: number;
  schema_version: number;
  payload: string;
}

/** §9: one envelope may not exceed 1 MiB. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
/** §9: a snapshot may not exceed 64 MiB. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/**
 * Splits a changeset so each envelope stays under the size cap. Rows are kept in order and never
 * split across envelopes, so one site's envelopes still apply in `db_version` order.
 *
 * `estimate` is how many bytes a row is expected to occupy once encoded; the caller supplies it so
 * this stays free of the CBOR dependency and testable on its own.
 */
export function chunkRows<T>(rows: T[], estimate: (row: T) => number, maxBytes = MAX_ENVELOPE_BYTES): T[][] {
  if (rows.length === 0) return [];
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const row of rows) {
    const rowSize = estimate(row);
    // A single oversized row still gets its own chunk: dropping it would lose data silently, and
    // the relay's rejection is a clearer failure than a gap.
    if (current.length > 0 && size + rowSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += rowSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
