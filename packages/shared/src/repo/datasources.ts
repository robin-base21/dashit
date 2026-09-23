import { uuidv7 } from "../ids.ts";
import { type LocalStore, type SqlValue, queryOne } from "../local-store.ts";
import { DATASOURCE_KINDS, type DatasourceRow, type DatasourceSampleRow, type FetchMode, type TrackMode } from "../types.ts";
import { removeEdgesForNode } from "./edges.ts";
import { encodeSecrets, hasSecrets, MIN_POLL_INTERVAL_MS, type DatasourceSecrets } from "../secrets.ts";
import { rowsForMerge, shapeSample, trackLimit } from "../track.ts";

export type CreateDatasourceInput =
  | { kind: "static"; name: string; value: unknown }
  | { kind: "internal"; name: string; source_element_id: string }
  | {
      kind: "external";
      name: string;
      url: string;
      fetch_mode: FetchMode;
      method?: string;
      poll_interval_ms?: number;
      response_path?: string;
      /** Headers and request body (API keys live here); stored in secrets_ciphertext. */
      secrets?: DatasourceSecrets;
      /** History tracking; null/omitted keeps only the latest value (ARCHITECTURE.md §5.4). */
      track_mode?: TrackMode | null;
      track_key?: string | null;
      track_limit?: number | null;
    };

export async function createDatasource(
  store: LocalStore,
  input: CreateDatasourceInput,
  now: number = Date.now(),
): Promise<string> {
  if (!DATASOURCE_KINDS.includes(input.kind)) throw new Error(`unknown datasource kind: ${input.kind}`);
  const id = uuidv7(now);
  switch (input.kind) {
    case "static":
      await store.exec(
        `INSERT INTO datasources (id, name, kind, static_value_json, created_at, updated_at) VALUES (?, ?, 'static', ?, ?, ?)`,
        [id, input.name, JSON.stringify(input.value ?? null), now, now],
      );
      break;
    case "internal":
      await store.exec(
        `INSERT INTO datasources (id, name, kind, source_element_id, created_at, updated_at) VALUES (?, ?, 'internal', ?, ?, ?)`,
        [id, input.name, input.source_element_id, now, now],
      );
      break;
    case "external":
      await store.exec(
        `INSERT INTO datasources (id, name, kind, fetch_mode, url, method, poll_interval_ms, response_path, secrets_ciphertext, track_mode, track_key, track_limit, created_at, updated_at)
         VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.fetch_mode,
          input.url,
          input.method ?? "GET",
          Math.max(MIN_POLL_INTERVAL_MS, input.poll_interval_ms ?? 60_000),
          input.response_path ?? null,
          input.secrets && hasSecrets(input.secrets) ? encodeSecrets(input.secrets) : null,
          input.track_mode ?? null,
          input.track_key ?? null,
          input.track_mode ? trackLimit(input.track_limit) : null,
          now,
          now,
        ],
      );
      break;
  }
  return id;
}

export async function getDatasource(store: LocalStore, id: string): Promise<DatasourceRow | undefined> {
  return queryOne<DatasourceRow>(store, `SELECT * FROM datasources WHERE id = ? AND deleted_at IS NULL`, [id]);
}

export async function listDatasources(store: LocalStore): Promise<DatasourceRow[]> {
  return store.query<DatasourceRow>(`SELECT * FROM datasources WHERE deleted_at IS NULL ORDER BY created_at, id`);
}

export async function updateDatasource(
  store: LocalStore,
  id: string,
  patch: {
    name?: string;
    url?: string;
    method?: string;
    poll_interval_ms?: number;
    response_path?: string | null;
    secrets?: DatasourceSecrets;
    static_value?: unknown;
    track_mode?: TrackMode | null;
    track_key?: string | null;
    track_limit?: number | null;
  },
  now: number = Date.now(),
): Promise<void> {
  const sets = ["updated_at = ?"];
  const params: SqlValue[] = [now];
  if (patch.name !== undefined) sets.push("name = ?"), params.push(patch.name);
  if (patch.url !== undefined) sets.push("url = ?"), params.push(patch.url);
  if (patch.method !== undefined) sets.push("method = ?"), params.push(patch.method);
  if (patch.poll_interval_ms !== undefined) sets.push("poll_interval_ms = ?"), params.push(Math.max(MIN_POLL_INTERVAL_MS, patch.poll_interval_ms));
  if (patch.response_path !== undefined) sets.push("response_path = ?"), params.push(patch.response_path);
  if (patch.secrets !== undefined) {
    sets.push("secrets_ciphertext = ?");
    params.push(hasSecrets(patch.secrets) ? encodeSecrets(patch.secrets) : null);
  }
  if (patch.static_value !== undefined) sets.push("static_value_json = ?"), params.push(JSON.stringify(patch.static_value));
  if (patch.track_mode !== undefined) sets.push("track_mode = ?"), params.push(patch.track_mode ?? null);
  if (patch.track_key !== undefined) sets.push("track_key = ?"), params.push(patch.track_key ?? null);
  if (patch.track_limit !== undefined) {
    sets.push("track_limit = ?");
    params.push(patch.track_limit === null ? null : trackLimit(patch.track_limit));
  }
  params.push(id);

  await store.transaction(async (tx) => {
    // Stored rows are shaped by the mode and identified by the key, so history from the old
    // settings cannot be read under the new ones. Compare against the current row rather than
    // trusting the patch: re-saving the dialog unchanged must not wipe a long recording.
    const current = await queryOne<Pick<DatasourceRow, "track_mode" | "track_key">>(
      tx,
      `SELECT track_mode, track_key FROM datasources WHERE id = ?`,
      [id],
    );
    const modeChanged = patch.track_mode !== undefined && (patch.track_mode ?? null) !== (current?.track_mode ?? null);
    const keyChanged = patch.track_key !== undefined && (patch.track_key ?? null) !== (current?.track_key ?? null);

    await tx.exec(`UPDATE datasources SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
    if (modeChanged || keyChanged) await tx.exec(`DELETE FROM datasource_samples WHERE datasource_id = ?`, [id]);
  });
}

export interface DatasourceCacheRow {
  datasource_id: string;
  value_json: string | null;
  fetched_at: number | null;
  error: string | null;
}

export async function listDatasourceCache(store: LocalStore): Promise<DatasourceCacheRow[]> {
  return store.query<DatasourceCacheRow>(`SELECT * FROM datasource_cache`);
}

/** Last fetched value or error for an external datasource; local-only, never synced. */
export async function setDatasourceCache(
  store: LocalStore,
  input: { datasource_id: string; value?: unknown; error?: string | null },
  now: number = Date.now(),
): Promise<void> {
  if (input.error) {
    // Keep the last good value so the dashboard can show stale data with the error.
    await store.exec(
      `INSERT INTO datasource_cache (datasource_id, value_json, fetched_at, error) VALUES (?, NULL, NULL, ?)
       ON CONFLICT(datasource_id) DO UPDATE SET error = excluded.error`,
      [input.datasource_id, input.error],
    );
    return;
  }
  await store.exec(
    `INSERT INTO datasource_cache (datasource_id, value_json, fetched_at, error) VALUES (?, ?, ?, NULL)
     ON CONFLICT(datasource_id) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at, error = NULL`,
    [input.datasource_id, JSON.stringify(input.value ?? null), now],
  );
}

/**
 * Every successful fetch of an external datasource, in one transaction: the latest-value cache
 * always, plus a history row when the source is tracked. One command rather than two calls from
 * the runtime, so the cache and the samples can never disagree.
 *
 * Failures do **not** come through here — they call `setDatasourceCache({ error })`, because a
 * transient 500 must not punch a hole in the recorded series.
 */
export async function recordDatasourceFetch(
  store: LocalStore,
  input: {
    datasource_id: string;
    value: unknown;
    track_mode?: TrackMode | null;
    track_key?: string | null;
    track_limit?: number | null;
  },
  now: number = Date.now(),
): Promise<void> {
  // Shaping throws on an unusable response (e.g. merge mode against a non-array); let it surface
  // before the transaction opens, so the caller reports it like any other fetch error.
  const rows = input.track_mode === "merge" ? rowsForMerge(input.value, input.track_key) : [];

  await store.transaction(async (tx) => {
    await setDatasourceCache(tx, { datasource_id: input.datasource_id, value: input.value }, now);
    if (!input.track_mode) return;

    if (input.track_mode === "sample") {
      await tx.exec(
        `INSERT INTO datasource_samples (datasource_id, sample_key, at, value_json) VALUES (?, ?, ?, ?)`,
        [input.datasource_id, uuidv7(now), now, JSON.stringify(shapeSample(input.value, now))],
      );
    } else {
      for (const { key, row } of rows) {
        await tx.exec(
          `INSERT INTO datasource_samples (datasource_id, sample_key, at, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(datasource_id, sample_key) DO UPDATE SET value_json = excluded.value_json, at = excluded.at`,
          [input.datasource_id, key, now, JSON.stringify(row)],
        );
      }
    }

    // Keep the newest N by deleting everything outside that set. Going the other way — deleting
    // rows older than the Nth newest via LIMIT 1 OFFSET N — keeps N+1 and is ambiguous when rows
    // share an `at`, which merge mode makes routine; the rowid tiebreak settles it.
    await tx.exec(
      `DELETE FROM datasource_samples WHERE datasource_id = ? AND rowid NOT IN (
         SELECT rowid FROM datasource_samples WHERE datasource_id = ? ORDER BY at DESC, rowid DESC LIMIT ?
       )`,
      [input.datasource_id, input.datasource_id, trackLimit(input.track_limit)],
    );
  });
}

/** Every tracked source's history, oldest first. Local-only, like the cache. */
export async function listDatasourceSamples(store: LocalStore): Promise<DatasourceSampleRow[]> {
  return store.query<DatasourceSampleRow>(
    `SELECT * FROM datasource_samples ORDER BY datasource_id, at, rowid`,
  );
}

export async function deleteDatasource(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.exec(`UPDATE datasources SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, id]);
    await removeEdgesForNode(tx, "datasource", id, now);
    await tx.exec(`DELETE FROM datasource_cache WHERE datasource_id = ?`, [id]);
    await tx.exec(`DELETE FROM datasource_samples WHERE datasource_id = ?`, [id]);
  });
}
