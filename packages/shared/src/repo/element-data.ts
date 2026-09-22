import type { LocalStore } from "../local-store.ts";
import { getElement } from "./elements.ts";
import { listTableCells, listTableColumns, listTableRows } from "./tables.ts";
import { listTaskItems } from "./task-items.ts";

export type Dataset = Record<string, unknown>[];

/**
 * An editable element exposed as a dataset (the `internal` datasource contract).
 * task/checklist: one record per item with tree metadata. table: one record per row keyed by column name.
 */
export async function readElementData(store: LocalStore, elementId: string): Promise<Dataset> {
  const el = await getElement(store, elementId);
  if (!el) return [];

  switch (el.kind) {
    case "task":
    case "checklist": {
      const items = await listTaskItems(store, elementId);
      const depth = new Map<string, number>();
      for (const it of items) depth.set(it.id, it.parent_id ? (depth.get(it.parent_id) ?? 0) + 1 : 0);
      return items.map((it) => ({
        id: it.id,
        title: it.title,
        done: it.done === 1,
        parent_id: it.parent_id,
        depth: depth.get(it.id) ?? 0,
        created_at: it.created_at,
        updated_at: it.updated_at,
      }));
    }
    case "table": {
      const [columns, rows, cells] = await Promise.all([
        listTableColumns(store, elementId),
        listTableRows(store, elementId),
        listTableCells(store, elementId),
      ]);
      const byRow = new Map<string, Map<string, unknown>>();
      for (const c of cells) {
        const m = byRow.get(c.row_id) ?? new Map<string, unknown>();
        m.set(c.column_id, c.value_json === null ? null : JSON.parse(c.value_json));
        byRow.set(c.row_id, m);
      }
      return rows.map((r) => {
        const record: Record<string, unknown> = { id: r.id };
        const m = byRow.get(r.id);
        for (const col of columns) record[col.name] = m?.get(col.id) ?? null;
        return record;
      });
    }
    default:
      return [];
  }
}
