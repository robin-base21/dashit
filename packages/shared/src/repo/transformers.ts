import { uuidv7 } from "../ids.ts";
import { type LocalStore, queryOne } from "../local-store.ts";
import type { TransformerRow, TransformerVersionRow } from "../types.ts";
import { removeEdgesForNode } from "./edges.ts";

export async function createTransformer(
  store: LocalStore,
  input: { name: string; code: string; site_id: string; note?: string; timeout_ms?: number },
  now: number = Date.now(),
): Promise<{ transformer_id: string; version_id: string }> {
  return store.transaction(async (tx) => {
    const transformer_id = uuidv7(now);
    await tx.exec(
      `INSERT INTO transformers (id, name, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [transformer_id, input.name, input.timeout_ms ?? 2000, now, now],
    );
    const version_id = await saveTransformerVersion(
      tx,
      { transformer_id, code: input.code, site_id: input.site_id, note: input.note },
      now,
    );
    return { transformer_id, version_id };
  });
}

/** Appends a version and points current_version_id at it. Versions are never updated. */
export async function saveTransformerVersion(
  store: LocalStore,
  input: { transformer_id: string; code: string; site_id: string; note?: string },
  now: number = Date.now(),
): Promise<string> {
  const id = uuidv7(now);
  await store.transaction(async (tx) => {
    await tx.exec(
      `INSERT INTO transformer_versions (id, transformer_id, code, note, created_by_site, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.transformer_id, input.code, input.note ?? null, input.site_id, now],
    );
    await tx.exec(`UPDATE transformers SET current_version_id = ?, updated_at = ? WHERE id = ?`, [
      id,
      now,
      input.transformer_id,
    ]);
  });
  return id;
}

export async function updateTransformer(
  store: LocalStore,
  id: string,
  patch: { name?: string; timeout_ms?: number },
  now: number = Date.now(),
): Promise<void> {
  const sets = ["updated_at = ?"];
  const params: (string | number)[] = [now];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.timeout_ms !== undefined) {
    sets.push("timeout_ms = ?");
    params.push(Math.max(100, Math.round(patch.timeout_ms)));
  }
  params.push(id);
  await store.exec(`UPDATE transformers SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
}

export async function setCurrentVersion(
  store: LocalStore,
  transformerId: string,
  versionId: string,
  now: number = Date.now(),
): Promise<void> {
  await store.exec(`UPDATE transformers SET current_version_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
    versionId,
    now,
    transformerId,
  ]);
}

export async function getTransformer(store: LocalStore, id: string): Promise<TransformerRow | undefined> {
  return queryOne<TransformerRow>(store, `SELECT * FROM transformers WHERE id = ? AND deleted_at IS NULL`, [id]);
}

export async function listTransformers(store: LocalStore): Promise<TransformerRow[]> {
  return store.query<TransformerRow>(`SELECT * FROM transformers WHERE deleted_at IS NULL ORDER BY created_at, id`);
}

export async function listTransformerVersions(store: LocalStore, transformerId: string): Promise<TransformerVersionRow[]> {
  return store.query<TransformerVersionRow>(
    `SELECT * FROM transformer_versions WHERE transformer_id = ? ORDER BY id DESC`,
    [transformerId],
  );
}

export async function deleteTransformer(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.exec(`UPDATE transformers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, id]);
    await removeEdgesForNode(tx, "transformer", id, now);
  });
}
