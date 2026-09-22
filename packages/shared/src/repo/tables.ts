import { uuidv7 } from "../ids.ts";
import type { LocalStore } from "../local-store.ts";
import { keyAfter } from "../sort-key.ts";
import { COLUMN_TYPES, type ColumnType, type TableCellRow, type TableColumnRow, type TableRowRow } from "../types.ts";

export async function listTableColumns(store: LocalStore, elementId: string): Promise<TableColumnRow[]> {
  return store.query<TableColumnRow>(
    `SELECT * FROM table_columns WHERE element_id = ? AND deleted_at IS NULL ORDER BY sort_key, id`,
    [elementId],
  );
}

export async function listTableRows(store: LocalStore, elementId: string): Promise<TableRowRow[]> {
  return store.query<TableRowRow>(
    `SELECT * FROM table_rows WHERE element_id = ? AND deleted_at IS NULL ORDER BY sort_key, id`,
    [elementId],
  );
}

/** Cells for every live row of the element; orphaned cells are excluded by the join. */
export async function listTableCells(store: LocalStore, elementId: string): Promise<TableCellRow[]> {
  return store.query<TableCellRow>(
    `SELECT c.* FROM table_cells c
     JOIN table_rows r ON r.id = c.row_id AND r.deleted_at IS NULL
     WHERE r.element_id = ?`,
    [elementId],
  );
}

export async function addTableColumn(
  store: LocalStore,
  input: { element_id: string; name?: string; data_type?: ColumnType },
  now: number = Date.now(),
): Promise<string> {
  const type = input.data_type ?? "string";
  if (!COLUMN_TYPES.includes(type)) throw new Error(`unknown column type: ${type}`);
  return store.transaction(async (tx) => {
    const existing = await tx.query<{ sort_key: string }>(
      `SELECT sort_key FROM table_columns WHERE element_id = ? AND deleted_at IS NULL`,
      [input.element_id],
    );
    const id = uuidv7(now);
    // Default name is computed inside the transaction so rapid adds never collide.
    const name = input.name ?? `Column ${existing.length + 1}`;
    await tx.exec(`INSERT INTO table_columns (id, element_id, name, data_type, sort_key) VALUES (?, ?, ?, ?, ?)`, [
      id,
      input.element_id,
      name,
      type,
      keyAfter(existing.map((k) => k.sort_key)),
    ]);
    return id;
  });
}

export async function updateTableColumn(
  store: LocalStore,
  id: string,
  patch: { name?: string; data_type?: ColumnType },
): Promise<void> {
  const sets: string[] = [];
  const params: string[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.data_type !== undefined) {
    if (!COLUMN_TYPES.includes(patch.data_type)) throw new Error(`unknown column type: ${patch.data_type}`);
    sets.push("data_type = ?");
    params.push(patch.data_type);
  }
  if (!sets.length) return;
  params.push(id);
  await store.exec(`UPDATE table_columns SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
}

export async function deleteTableColumn(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.exec(`UPDATE table_columns SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, id]);
}

export async function addTableRow(
  store: LocalStore,
  input: { element_id: string; cells?: Record<string, unknown> },
  now: number = Date.now(),
): Promise<string> {
  return store.transaction(async (tx) => {
    const keys = await tx.query<{ sort_key: string }>(
      `SELECT sort_key FROM table_rows WHERE element_id = ? AND deleted_at IS NULL`,
      [input.element_id],
    );
    const id = uuidv7(now);
    await tx.exec(`INSERT INTO table_rows (id, element_id, sort_key, created_at) VALUES (?, ?, ?, ?)`, [
      id,
      input.element_id,
      keyAfter(keys.map((k) => k.sort_key)),
      now,
    ]);
    for (const [column_id, value] of Object.entries(input.cells ?? {})) {
      await setTableCell(tx, { row_id: id, column_id, value }, now);
    }
    return id;
  });
}

export async function deleteTableRow(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.exec(`UPDATE table_rows SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, id]);
}

export async function setTableCell(
  store: LocalStore,
  input: { row_id: string; column_id: string; value: unknown },
  now: number = Date.now(),
): Promise<void> {
  const value_json = input.value === undefined || input.value === null ? null : JSON.stringify(input.value);
  await store.exec(
    `INSERT INTO table_cells (row_id, column_id, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(row_id, column_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [input.row_id, input.column_id, value_json, now],
  );
}
