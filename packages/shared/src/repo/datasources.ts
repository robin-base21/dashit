import { uuidv7 } from "../ids.ts";
import { type LocalStore, queryOne } from "../local-store.ts";
import { DATASOURCE_KINDS, type DatasourceRow, type FetchMode } from "../types.ts";
import { removeEdgesForNode } from "./edges.ts";

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
        `INSERT INTO datasources (id, name, kind, fetch_mode, url, method, poll_interval_ms, response_path, created_at, updated_at)
         VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.fetch_mode,
          input.url,
          input.method ?? "GET",
          input.poll_interval_ms ?? 60_000,
          input.response_path ?? null,
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

export async function deleteDatasource(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.exec(`UPDATE datasources SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, id]);
    await removeEdgesForNode(tx, "datasource", id, now);
    await tx.exec(`DELETE FROM datasource_cache WHERE datasource_id = ?`, [id]);
  });
}
