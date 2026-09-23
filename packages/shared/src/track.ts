/**
 * Shaping rules for tracked datasource history (ARCHITECTURE.md §5.4). Pure: the storage and
 * eviction that use these live in `repo/datasources.ts`, because they depend on existing rows.
 */

export const DEFAULT_TRACK_LIMIT = 500;
export const MIN_TRACK_LIMIT = 2;
export const MAX_TRACK_LIMIT = 10_000;

/** The field `sample` mode stamps onto every row; see `shapeSample`. */
export const SAMPLED_AT_FIELD = "sampled_at";

export function trackLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_TRACK_LIMIT;
  return Math.min(MAX_TRACK_LIMIT, Math.max(MIN_TRACK_LIMIT, Math.floor(limit)));
}

/**
 * One `sample` row: the response's own fields spread flat, plus an ISO timestamp so the series has
 * an x axis. A scalar response becomes `{ value }`, matching `toRecords()` in `aggregate.ts`.
 *
 * `sampled_at` is written last and therefore **shadows** a response field of the same name — the
 * name is deliberately unlikely to collide, where `t` (which a metrics payload plausibly carries)
 * would have.
 */
export function shapeSample(value: unknown, at: number): Record<string, unknown> {
  const base = isPlainObject(value) ? value : { value };
  return { ...base, [SAMPLED_AT_FIELD]: new Date(at).toISOString() };
}

export interface MergeRow {
  /** Identity for the upsert: `String(row[trackKey])`. */
  key: string;
  row: Record<string, unknown>;
}

/**
 * `merge` rows, keyed for upsert. Rows are stored exactly as the API returned them — no injected
 * timestamp, since ingest time lives in its own column and a second date-looking field inside the
 * JSON would only confuse whoever charts it.
 *
 * Throws rather than storing nothing when the response cannot be merged, so a misconfigured key
 * surfaces through the same channel as an HTTP failure instead of looking like an idle source.
 * An empty array is not an error: an API is allowed to have nothing to say.
 */
export function rowsForMerge(value: unknown, trackKey: string | null | undefined): MergeRow[] {
  if (!trackKey) throw new Error("merge tracking needs a key field");
  if (!Array.isArray(value)) throw new Error(`merge tracking needs an array response, got ${describe(value)}`);
  if (value.length === 0) return [];

  const rows: MergeRow[] = [];
  for (const row of value) {
    if (!isPlainObject(row)) continue;
    const key = row[trackKey];
    if (key === undefined || key === null) continue;
    rows.push({ key: String(key), row });
  }
  if (rows.length === 0) throw new Error(`no row in the response has a "${trackKey}" field`);
  return rows;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}
