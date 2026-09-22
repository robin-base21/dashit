import { uuidv7 } from "../ids.ts";
import { type LocalStore, type SqlValue, queryOne } from "../local-store.ts";
import { DATASOURCE_KINDS, type DatasourceRow, type FetchMode } from "../types.ts";
import { removeEdgesForNode } from "./edges.ts";
import { encodeSecrets, MIN_POLL_INTERVAL_MS } from "../secrets.ts";

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
      /** Request headers (API keys live here). Stored via setDatasourceSecrets. */
      headers?: Record<string, string>;
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
        `INSERT INTO datasources (id, name, kind, fetch_mode, url, method, poll_interval_ms, response_path, secrets_ciphertext, created_at, updated_at)
         VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.fetch_mode,
          input.url,
          input.method ?? "GET",
          Math.max(MIN_POLL_INTERVAL_MS, input.poll_interval_ms ?? 60_000),
          input.response_path ?? null,
          input.headers && Object.keys(input.headers).length ? encodeSecrets({ headers: input.headers }) : null,
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
    headers?: Record<string, string>;
    static_value?: unknown;
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
  if (patch.headers !== undefined) {
    sets.push("secrets_ciphertext = ?");
    params.push(Object.keys(patch.headers).length ? encodeSecrets({ headers: patch.headers }) : null);
  }
  if (patch.static_value !== undefined) sets.push("static_value_json = ?"), params.push(JSON.stringify(patch.static_value));
  params.push(id);
  await store.exec(`UPDATE datasources SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
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

export async function deleteDatasource(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.exec(`UPDATE datasources SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, id]);
    await removeEdgesForNode(tx, "datasource", id, now);
    await tx.exec(`DELETE FROM datasource_cache WHERE datasource_id = ?`, [id]);
  });
}
