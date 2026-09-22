import { toast } from "svelte-sonner";
import type { Db } from "$lib/db/client.svelte";

const DAY = 24 * 60 * 60 * 1000;

export interface StorageInfo {
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

export async function readStorageInfo(): Promise<StorageInfo> {
  const info: StorageInfo = { persisted: null, usageBytes: null, quotaBytes: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usageBytes = e.usage ?? null;
      info.quotaBytes = e.quota ?? null;
    }
  } catch {
    // unsupported
  }
  return info;
}

export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Oldest element creation time, or null when there is no data yet. */
export async function oldestDataAt(db: Db): Promise<number | null> {
  const elements = await db.call("listElements");
  if (!elements.length) return null;
  return Math.min(...elements.map((e) => e.created_at));
}

/**
 * Anonymous mode has no backup. Once local-only data is older than a day, remind the user at most
 * once per day (ARCHITECTURE.md §4.9) and ask the browser to persist storage.
 */
export async function runEvictionCheck(db: Db, onExport: () => void, now: number = Date.now()): Promise<void> {
  const oldest = await oldestDataAt(db);
  if (oldest === null) return;

  const info = await readStorageInfo();
  if (info.persisted === false) await requestPersistence();

  if (now - oldest < DAY) return;
  const last = Number((await db.call("getLocalMeta", "eviction_toast_at")) ?? 0);
  if (now - last < DAY) return;
  await db.call("setLocalMeta", "eviction_toast_at", String(now));

  toast.warning("Your data lives only in this browser", {
    description: "Browser storage can be cleared. Export a backup, or create an account for sync once available.",
    duration: 12_000,
    action: { label: "Export", onClick: onExport },
  });
}

export function formatBytes(n: number | null): string {
  if (n === null) return "unknown";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / KB).toFixed(0)} KB`;
}
