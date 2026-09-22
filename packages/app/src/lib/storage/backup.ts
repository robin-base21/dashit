import { parseExportFile, type ImportSummary } from "shared";
import type { Db } from "$lib/db/client.svelte";

export async function downloadExport(db: Db): Promise<void> {
  const data = await db.call("exportData");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dashit-${new Date(data.exported_at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  await db.call("setLocalMeta", "last_export_at", String(data.exported_at));
}

export async function importFromFile(db: Db, file: File): Promise<ImportSummary> {
  const text = await file.text();
  const parsed = parseExportFile(JSON.parse(text));
  return db.call("importData", parsed);
}
