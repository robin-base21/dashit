import { Database } from "bun:sqlite";
import { MIGRATIONS, RELAY_SCHEMA_VERSION } from "./schema.ts";

/**
 * Opens the relay database and brings it up to date. `:memory:` is a first-class caller here —
 * the whole test suite runs against one.
 */
export function openDb(path = process.env.DASHIT_DB ?? "dashit-relay.db"): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT)`);
  const row = db.query<{ value: string | null }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  let version = Number(row?.value ?? 0);

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.transaction(() => {
      for (const sql of m.statements) db.exec(sql);
      db.query(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version));
    })();
    version = m.version;
  }
  if (version !== RELAY_SCHEMA_VERSION) throw new Error(`relay schema at v${version}, expected v${RELAY_SCHEMA_VERSION}`);
  return version;
}
