import type { LocalStore } from "./local-store.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export interface MigrateOptions {
  /** Register synced tables with cr-sqlite. False for plain-SQLite test doubles. */
  crr: boolean;
}

export class SchemaTooNewError extends Error {
  constructor(
    public readonly dbVersion: number,
    public readonly appVersion: number,
  ) {
    super(`database schema v${dbVersion} is newer than this app's v${appVersion}`);
    this.name = "SchemaTooNewError";
  }
}

export async function currentSchemaVersion(store: LocalStore): Promise<number> {
  const tables = await store.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_meta'`,
  );
  if (tables.length === 0) return 0;
  const rows = await store.query<{ value: string | null }>(
    `SELECT value FROM local_meta WHERE key = 'schema_version'`,
  );
  return Number(rows[0]?.value ?? 0);
}

/** Applies pending migrations in order, each in its own transaction. Returns the resulting version. */
export async function migrate(store: LocalStore, opts: MigrateOptions): Promise<number> {
  let version = await currentSchemaVersion(store);
  if (version > SCHEMA_VERSION) throw new SchemaTooNewError(version, SCHEMA_VERSION);

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;

    // cr-sqlite's alter/crr functions manage their own savepoints and fail inside an open transaction.
    if (opts.crr) {
      for (const t of m.alteredCrrTables ?? []) await store.exec(`SELECT crsql_begin_alter(?)`, [t]);
    }
    await store.transaction(async (tx) => {
      for (const sql of m.statements) await tx.exec(sql);
    });
    if (opts.crr) {
      for (const t of m.alteredCrrTables ?? []) await store.exec(`SELECT crsql_commit_alter(?)`, [t]);
      for (const t of m.crrTables ?? []) await store.exec(`SELECT crsql_as_crr(?)`, [t]);
    }
    await store.exec(
      `INSERT INTO local_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(m.version)],
    );
    version = m.version;
  }
  return version;
}
