import { uuidv7 } from "../ids.ts";
import type { LocalStore } from "../local-store.ts";
import { keyAfter, keyBetween } from "../sort-key.ts";
import type { TaskItemRow } from "../types.ts";

export async function listTaskItems(store: LocalStore, elementId: string): Promise<TaskItemRow[]> {
  return store.query<TaskItemRow>(
    `SELECT * FROM task_items WHERE element_id = ? AND deleted_at IS NULL ORDER BY sort_key, id`,
    [elementId],
  );
}

export interface AddTaskItemInput {
  element_id: string;
  title: string;
  parent_id?: string | null;
  /** Insert after this sibling; default appends at the end of the sibling list. */
  after_id?: string | null;
}

export async function addTaskItem(store: LocalStore, input: AddTaskItemInput, now: number = Date.now()): Promise<string> {
  return store.transaction(async (tx) => {
    const parent = input.parent_id ?? null;
    const siblings = await tx.query<{ id: string; sort_key: string }>(
      `SELECT id, sort_key FROM task_items WHERE element_id = ? AND deleted_at IS NULL AND parent_id IS ?
       ORDER BY sort_key, id`,
      [input.element_id, parent],
    );
    let sort_key: string;
    if (input.after_id) {
      const i = siblings.findIndex((s) => s.id === input.after_id);
      sort_key = i === -1 ? keyAfter(siblings.map((s) => s.sort_key)) : keyBetween(siblings[i]!.sort_key, siblings[i + 1]?.sort_key ?? null);
    } else {
      sort_key = keyAfter(siblings.map((s) => s.sort_key));
    }
    const id = uuidv7(now);
    await tx.exec(
      `INSERT INTO task_items (id, element_id, parent_id, title, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.element_id, parent, input.title, sort_key, now, now],
    );
    return id;
  });
}

export async function updateTaskItem(
  store: LocalStore,
  id: string,
  patch: { title?: string; done?: boolean },
  now: number = Date.now(),
): Promise<void> {
  const sets = ["updated_at = ?"];
  const params: (string | number)[] = [now];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.done !== undefined) {
    sets.push("done = ?");
    params.push(patch.done ? 1 : 0);
  }
  params.push(id);
  await store.exec(`UPDATE task_items SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
}

/** Re-parents and/or repositions an item between two siblings (either may be null). */
export async function moveTaskItem(
  store: LocalStore,
  id: string,
  target: { parent_id: string | null; before_key: string | null; after_key: string | null },
  now: number = Date.now(),
): Promise<void> {
  const sort_key = keyBetween(target.before_key, target.after_key);
  await store.exec(`UPDATE task_items SET parent_id = ?, sort_key = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
    target.parent_id,
    sort_key,
    now,
    id,
  ]);
}

/** Soft-deletes an item and its whole subtree. */
export async function deleteTaskItem(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    const [root] = await tx.query<{ element_id: string }>(`SELECT element_id FROM task_items WHERE id = ?`, [id]);
    if (!root) return;
    const rows = await tx.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM task_items WHERE element_id = ? AND deleted_at IS NULL`,
      [root.element_id],
    );
    const children = new Map<string | null, string[]>();
    for (const r of rows) {
      const arr = children.get(r.parent_id) ?? [];
      arr.push(r.id);
      children.set(r.parent_id, arr);
    }
    const toDelete: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      toDelete.push(cur);
      for (const c of children.get(cur) ?? []) stack.push(c);
    }
    for (const d of toDelete) {
      await tx.exec(`UPDATE task_items SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, d]);
    }
  });
}
