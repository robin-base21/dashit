import type { LocalStore, SqlValue } from "../local-store.ts";
import { SCHEMA_VERSION, SYNCED_TABLES } from "../schema.ts";

export interface ExportFile {
  format: "dashit-export";
  version: 1;
  schema_version: number;
  exported_at: number;
  tables: Record<string, Record<string, unknown>[]>;
}

/** Plaintext JSON of every synced table (including tombstones so a restore is faithful). */
export async function exportData(store: LocalStore, now: number = Date.now()): Promise<ExportFile> {
  const tables: ExportFile["tables"] = {};
  for (const t of SYNCED_TABLES) {
    const rows = await store.query<Record<string, unknown>>(`SELECT * FROM ${t}`);
    tables[t] = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v instanceof Uint8Array ? { $bytes: Array.from(v) } : v;
      return out;
    });
  }
  return { format: "dashit-export", version: 1, schema_version: SCHEMA_VERSION, exported_at: now, tables };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export function parseExportFile(input: unknown): ExportFile {
  if (!input || typeof input !== "object") throw new ImportError("not a JSON object");
  const f = input as Partial<ExportFile>;
  if (f.format !== "dashit-export") throw new ImportError("not a DashIt export file");
  if (f.version !== 1) throw new ImportError(`unsupported export version ${String(f.version)}`);
  if (typeof f.schema_version !== "number") throw new ImportError("missing schema_version");
  if (f.schema_version > SCHEMA_VERSION) throw new ImportError("export was made by a newer app version; update first");
  if (!f.tables || typeof f.tables !== "object") throw new ImportError("missing tables");
  return f as ExportFile;
}

export interface ImportSummary {
  rows: number;
  tables: Record<string, number>;
}

/**
 * Merges rows by primary key (upsert). Unknown tables/columns are ignored so older exports import
 * cleanly. Runs in one transaction.
 */
export async function importData(store: LocalStore, file: ExportFile): Promise<ImportSummary> {
  const summary: ImportSummary = { rows: 0, tables: {} };
  await store.transaction(async (tx) => {
    for (const t of SYNCED_TABLES) {
      const rows = file.tables[t];
      if (!rows?.length) continue;
      const info = await tx.query<{ name: string; pk: number }>(`PRAGMA table_info(${t})`);
      const columns = info.map((c) => c.name);
      const pks = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      let n = 0;
      for (const row of rows) {
        const present = columns.filter((c) => c in row);
        if (!pks.every((pk) => present.includes(pk))) continue;
        const values = present.map((c) => decode(row[c]));
        const updates = present.filter((c) => !pks.includes(c)).map((c) => `${c} = excluded.${c}`);
        await tx.exec(
          `INSERT INTO ${t} (${present.join(", ")}) VALUES (${present.map(() => "?").join(", ")})
           ON CONFLICT(${pks.join(", ")}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
          values,
        );
        n++;
      }
      summary.tables[t] = n;
      summary.rows += n;
    }
  });
  return summary;
}

function decode(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v !== null && "$bytes" in v && Array.isArray((v as { $bytes: unknown }).$bytes)) {
    return new Uint8Array((v as { $bytes: number[] }).$bytes);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}
