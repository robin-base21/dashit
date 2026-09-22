import type { LocalStore } from "../local-store.ts";

export async function getLocalMeta(store: LocalStore, key: string): Promise<string | null> {
  const [row] = await store.query<{ value: string | null }>(`SELECT value FROM local_meta WHERE key = ?`, [key]);
  return row?.value ?? null;
}

export async function setLocalMeta(store: LocalStore, key: string, value: string | null): Promise<void> {
  await store.exec(
    `INSERT INTO local_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
