import { uuidv7 } from "../ids.ts";
import { type LocalStore, queryOne } from "../local-store.ts";
import { ELEMENT_KINDS, type ElementKind, type ElementRow, type PlacementRow } from "../types.ts";

export interface CreateElementInput {
  kind: ElementKind;
  title?: string;
  config?: Record<string, unknown>;
}

export async function createElement(
  store: LocalStore,
  input: CreateElementInput,
  now: number = Date.now(),
): Promise<string> {
  if (!ELEMENT_KINDS.includes(input.kind)) throw new Error(`unknown element kind: ${input.kind}`);
  const id = uuidv7(now);
  await store.exec(
    `INSERT INTO elements (id, kind, title, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.title ?? "", JSON.stringify(input.config ?? {}), now, now],
  );
  return id;
}

export async function getElement(store: LocalStore, id: string): Promise<ElementRow | undefined> {
  return queryOne<ElementRow>(store, `SELECT * FROM elements WHERE id = ? AND deleted_at IS NULL`, [id]);
}

export async function listElements(store: LocalStore): Promise<ElementRow[]> {
  return store.query<ElementRow>(`SELECT * FROM elements WHERE deleted_at IS NULL ORDER BY created_at, id`);
}

export async function updateElement(
  store: LocalStore,
  id: string,
  patch: { title?: string; config?: Record<string, unknown> },
  now: number = Date.now(),
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const params: (string | number)[] = [now];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.config !== undefined) {
    sets.push("config_json = ?");
    params.push(JSON.stringify(patch.config));
  }
  params.push(id);
  await store.exec(`UPDATE elements SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * Soft-deletes an element and cascades to its placement, edges (both directions),
 * and kind-specific rows. table_cells are left as orphans for GC (ARCHITECTURE.md §2.6).
 */
export async function deleteElement(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.exec(`UPDATE elements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, id]);
    await tx.exec(`UPDATE placements SET deleted_at = ?, updated_at = ? WHERE element_id = ? AND deleted_at IS NULL`, [now, now, id]);
    await tx.exec(
      `UPDATE edges SET deleted_at = ? WHERE deleted_at IS NULL AND (
         (consumer_kind = 'element' AND consumer_id = ?) )`,
      [now, id],
    );
    await tx.exec(`UPDATE task_items SET deleted_at = ?, updated_at = ? WHERE element_id = ? AND deleted_at IS NULL`, [now, now, id]);
    await tx.exec(`UPDATE table_columns SET deleted_at = ? WHERE element_id = ? AND deleted_at IS NULL`, [now, id]);
    await tx.exec(`UPDATE table_rows SET deleted_at = ? WHERE element_id = ? AND deleted_at IS NULL`, [now, id]);
  });
}

export interface PlacementInput {
  dashboard_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Places (or re-places) an element. Upsert on element_id; clears any tombstone. */
export async function placeElement(
  store: LocalStore,
  elementId: string,
  p: PlacementInput,
  now: number = Date.now(),
): Promise<void> {
  await store.exec(
    `INSERT INTO placements (element_id, dashboard_id, x, y, w, h, hidden, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)
     ON CONFLICT(element_id) DO UPDATE SET
       dashboard_id = excluded.dashboard_id,
       x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
       hidden = 0, updated_at = excluded.updated_at, deleted_at = NULL`,
    [elementId, p.dashboard_id, p.x, p.y, p.w, p.h, now],
  );
}

export async function movePlacement(
  store: LocalStore,
  elementId: string,
  rect: { x: number; y: number; w: number; h: number },
  now: number = Date.now(),
): Promise<void> {
  await store.exec(
    `UPDATE placements SET x = ?, y = ?, w = ?, h = ?, updated_at = ? WHERE element_id = ? AND deleted_at IS NULL`,
    [rect.x, rect.y, rect.w, rect.h, now, elementId],
  );
}

export async function unplaceElement(store: LocalStore, elementId: string, now: number = Date.now()): Promise<void> {
  await store.exec(
    `UPDATE placements SET deleted_at = ?, updated_at = ? WHERE element_id = ? AND deleted_at IS NULL`,
    [now, now, elementId],
  );
}

export async function setPlacementHidden(
  store: LocalStore,
  elementId: string,
  hidden: boolean,
  now: number = Date.now(),
): Promise<void> {
  await store.exec(
    `UPDATE placements SET hidden = ?, updated_at = ? WHERE element_id = ? AND deleted_at IS NULL`,
    [hidden ? 1 : 0, now, elementId],
  );
}

export async function listPlacements(store: LocalStore, dashboardId: string): Promise<PlacementRow[]> {
  return store.query<PlacementRow>(
    `SELECT p.* FROM placements p
     JOIN elements e ON e.id = p.element_id AND e.deleted_at IS NULL
     WHERE p.dashboard_id = ? AND p.deleted_at IS NULL
     ORDER BY p.y, p.x`,
    [dashboardId],
  );
}

/** Element ids that count as active consumers: placed, visible, alive (§5.3). */
export async function listVisibleElementIds(store: LocalStore): Promise<string[]> {
  const rows = await store.query<{ element_id: string }>(
    `SELECT p.element_id FROM placements p
     JOIN elements e ON e.id = p.element_id AND e.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.hidden = 0`,
  );
  return rows.map((r) => r.element_id);
}
