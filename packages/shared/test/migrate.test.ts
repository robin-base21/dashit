import { describe, expect, test } from "bun:test";
import { currentSchemaVersion, migrate, SchemaTooNewError } from "../src/migrate.ts";
import { LOCAL_TABLES, SCHEMA_VERSION, SYNCED_TABLES } from "../src/schema.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

describe("migrate", () => {
  test("creates every table and records the version", async () => {
    const store = new BunSqliteStore();
    expect(await currentSchemaVersion(store)).toBe(0);

    const v = await migrate(store, { crr: false });
    expect(v).toBe(SCHEMA_VERSION);
    expect(await currentSchemaVersion(store)).toBe(SCHEMA_VERSION);

    const tables = new Set(
      (await store.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name),
    );
    for (const t of [...SYNCED_TABLES, ...LOCAL_TABLES]) expect(tables.has(t)).toBe(true);
  });

  test("is idempotent", async () => {
    const store = new BunSqliteStore();
    await migrate(store, { crr: false });
    await migrate(store, { crr: false });
    expect(await currentSchemaVersion(store)).toBe(SCHEMA_VERSION);
  });

  test("refuses a database newer than the app", async () => {
    const store = new BunSqliteStore();
    await migrate(store, { crr: false });
    await store.exec(`UPDATE local_meta SET value = ? WHERE key = 'schema_version'`, [String(SCHEMA_VERSION + 1)]);
    await expect(migrate(store, { crr: false })).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  test("synced tables obey CRR rules: PK present, non-PK columns nullable or defaulted, no FKs", async () => {
    const store = new BunSqliteStore();
    await migrate(store, { crr: false });

    for (const t of SYNCED_TABLES) {
      const cols = await store.query<{ name: string; notnull: number; dflt_value: string | null; pk: number }>(
        `PRAGMA table_info(${t})`,
      );
      expect(cols.some((c) => c.pk > 0)).toBe(true);
      for (const c of cols) {
        // cr-sqlite: "CRRs must have a non nullable primary key"
        if (c.pk > 0) {
          expect(c.notnull, `${t}.${c.name} PK must be NOT NULL`).toBe(1);
          continue;
        }
        if (c.notnull === 1) expect(c.dflt_value, `${t}.${c.name} is NOT NULL without DEFAULT`).not.toBeNull();
      }
      const fks = await store.query(`PRAGMA foreign_key_list(${t})`);
      expect(fks).toHaveLength(0);
      const indexes = await store.query<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${t})`);
      for (const ix of indexes) {
        if (ix.origin === "pk") continue;
        expect(ix.unique, `${t} has secondary unique index ${ix.name}`).toBe(0);
      }
    }
  });
});
