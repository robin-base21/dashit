import { uuidv7 } from "../ids.ts";
import { type LocalStore, queryOne } from "../local-store.ts";
import type { DashboardRow } from "../types.ts";

export async function createDashboard(
  store: LocalStore,
  input: { name?: string; grid_cols?: number } = {},
  now: number = Date.now(),
): Promise<string> {
  const id = uuidv7(now);
  await store.exec(
    `INSERT INTO dashboards (id, name, grid_cols, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.name ?? "Dashboard", input.grid_cols ?? 12, now, now],
  );
  return id;
}

/** Returns the oldest live dashboard, creating one if none exists. */
export async function ensureDefaultDashboard(store: LocalStore, now: number = Date.now()): Promise<string> {
  const row = await queryOne<Pick<DashboardRow, "id">>(
    store,
    `SELECT id FROM dashboards WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 1`,
  );
  return row?.id ?? createDashboard(store, {}, now);
}

export async function listDashboards(store: LocalStore): Promise<DashboardRow[]> {
  return store.query<DashboardRow>(
    `SELECT * FROM dashboards WHERE deleted_at IS NULL ORDER BY created_at, id`,
  );
}
