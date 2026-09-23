/**
 * Canonical schema, expressed as ordered migrations. See ARCHITECTURE.md §2.
 *
 * CRR rules for every synced table: explicit PRIMARY KEY; every non-PK column nullable
 * or DEFAULTed; no FOREIGN KEY, CHECK, or secondary UNIQUE constraints. Validation and
 * cascades live in the repositories.
 */

export interface Migration {
  version: number;
  statements: string[];
  /** Tables to register with crsql_as_crr once this migration has run. */
  crrTables?: string[];
  /** Existing CRR tables altered by this migration (wrapped in crsql_begin/commit_alter). */
  alteredCrrTables?: string[];
}

export const SYNCED_TABLES = [
  "dashboards",
  "elements",
  "placements",
  "task_items",
  "table_columns",
  "table_rows",
  "table_cells",
  "datasources",
  "transformers",
  "transformer_versions",
  "edges",
] as const;

export const LOCAL_TABLES = [
  "local_meta",
  "datasource_cache",
  "datasource_samples",
  "local_secrets",
  "sync_state",
  "ai_egress_log",
] as const;

const v1: Migration = {
  version: 1,
  statements: [
    `CREATE TABLE IF NOT EXISTS local_meta (
      key    TEXT PRIMARY KEY NOT NULL,
      value  TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS dashboards (
      id          TEXT PRIMARY KEY NOT NULL,
      name        TEXT    NOT NULL DEFAULT 'Dashboard',
      grid_cols   INTEGER NOT NULL DEFAULT 12,
      created_at  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS elements (
      id          TEXT PRIMARY KEY NOT NULL,
      kind        TEXT    NOT NULL DEFAULT '',
      title       TEXT    NOT NULL DEFAULT '',
      config_json TEXT    NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS placements (
      element_id   TEXT PRIMARY KEY NOT NULL,
      dashboard_id TEXT    NOT NULL DEFAULT '',
      x            INTEGER NOT NULL DEFAULT 0,
      y            INTEGER NOT NULL DEFAULT 0,
      w            INTEGER NOT NULL DEFAULT 4,
      h            INTEGER NOT NULL DEFAULT 3,
      hidden       INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0,
      deleted_at   INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_placements_dashboard ON placements(dashboard_id)`,

    `CREATE TABLE IF NOT EXISTS task_items (
      id          TEXT PRIMARY KEY NOT NULL,
      element_id  TEXT    NOT NULL DEFAULT '',
      parent_id   TEXT,
      title       TEXT    NOT NULL DEFAULT '',
      done        INTEGER NOT NULL DEFAULT 0,
      sort_key    TEXT    NOT NULL DEFAULT 'a0',
      created_at  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_items_element ON task_items(element_id)`,

    `CREATE TABLE IF NOT EXISTS table_columns (
      id          TEXT PRIMARY KEY NOT NULL,
      element_id  TEXT    NOT NULL DEFAULT '',
      name        TEXT    NOT NULL DEFAULT '',
      data_type   TEXT    NOT NULL DEFAULT 'string',
      sort_key    TEXT    NOT NULL DEFAULT 'a0',
      deleted_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_table_columns_element ON table_columns(element_id)`,

    `CREATE TABLE IF NOT EXISTS table_rows (
      id          TEXT PRIMARY KEY NOT NULL,
      element_id  TEXT    NOT NULL DEFAULT '',
      sort_key    TEXT    NOT NULL DEFAULT 'a0',
      created_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_table_rows_element ON table_rows(element_id)`,

    `CREATE TABLE IF NOT EXISTS table_cells (
      row_id      TEXT NOT NULL,
      column_id   TEXT NOT NULL,
      value_json  TEXT,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (row_id, column_id)
    )`,

    `CREATE TABLE IF NOT EXISTS datasources (
      id                 TEXT PRIMARY KEY NOT NULL,
      name               TEXT    NOT NULL DEFAULT '',
      kind               TEXT    NOT NULL DEFAULT 'static',
      fetch_mode         TEXT,
      url                TEXT,
      method             TEXT,
      poll_interval_ms   INTEGER,
      response_path      TEXT,
      secrets_ciphertext BLOB,
      source_element_id  TEXT,
      static_value_json  TEXT,
      created_at         INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL DEFAULT 0,
      deleted_at         INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS transformers (
      id                  TEXT PRIMARY KEY NOT NULL,
      name                TEXT    NOT NULL DEFAULT '',
      current_version_id  TEXT,
      timeout_ms          INTEGER NOT NULL DEFAULT 2000,
      created_at          INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL DEFAULT 0,
      deleted_at          INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS transformer_versions (
      id               TEXT PRIMARY KEY NOT NULL,
      transformer_id   TEXT    NOT NULL DEFAULT '',
      code             TEXT    NOT NULL DEFAULT '',
      note             TEXT,
      created_by_site  TEXT    NOT NULL DEFAULT '',
      created_at       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transformer_versions_t ON transformer_versions(transformer_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS edges (
      id             TEXT PRIMARY KEY NOT NULL,
      consumer_kind  TEXT    NOT NULL DEFAULT '',
      consumer_id    TEXT    NOT NULL DEFAULT '',
      producer_kind  TEXT    NOT NULL DEFAULT '',
      producer_id    TEXT    NOT NULL DEFAULT '',
      position       INTEGER NOT NULL DEFAULT 0,
      config_json    TEXT    NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL DEFAULT 0,
      deleted_at     INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_edges_producer ON edges(producer_kind, producer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_edges_consumer ON edges(consumer_kind, consumer_id)`,

    `CREATE TABLE IF NOT EXISTS datasource_cache (
      datasource_id  TEXT PRIMARY KEY NOT NULL,
      value_json     TEXT,
      fetched_at     INTEGER,
      error          TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS local_secrets (
      key               TEXT PRIMARY KEY NOT NULL,
      value_ciphertext  BLOB NOT NULL,
      updated_at        INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS sync_state (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      last_pushed_db_version  INTEGER NOT NULL DEFAULT 0,
      last_pulled_seq         INTEGER NOT NULL DEFAULT 0,
      last_snapshot_seq       INTEGER NOT NULL DEFAULT 0,
      last_sync_ok_at         INTEGER,
      last_sync_error         TEXT
    )`,
    `INSERT OR IGNORE INTO sync_state (id) VALUES (1)`,

    `CREATE TABLE IF NOT EXISTS ai_egress_log (
      id             TEXT PRIMARY KEY NOT NULL,
      at             INTEGER NOT NULL,
      provider       TEXT NOT NULL,
      transformer_id TEXT,
      sample_bytes   INTEGER NOT NULL
    )`,
  ],
  crrTables: [...SYNCED_TABLES],
};

/**
 * `checklist` was merged into `task`. The two kinds already shared `task_items` and rendered the
 * same tree — only the default collapse state differed — so existing rows are rewritten rather
 * than stranded on a kind the app no longer knows. Data only: no DDL, so no CRR alter.
 */
const v2: Migration = {
  version: 2,
  statements: [`UPDATE elements SET kind = 'task' WHERE kind = 'checklist'`],
};

/**
 * History for tracked external datasources. Local-only, like `datasource_cache`: syncing a row per
 * poll would be pure churn through the relay, so each device accumulates its own samples.
 *
 * `sample_key` is what makes one code path serve both modes — an append (`uuidv7()`, unique per
 * fetch) or an upsert (the merge key's value). `at` is ingest time, never parsed out of the key:
 * a numeric key may be a counter or a price, and guessing wrong would date rows to 1970 and wreck
 * the eviction order.
 */
const v3: Migration = {
  version: 3,
  statements: [
    `CREATE TABLE IF NOT EXISTS datasource_samples (
      datasource_id  TEXT    NOT NULL,
      sample_key     TEXT    NOT NULL,
      at             INTEGER NOT NULL,
      value_json     TEXT    NOT NULL,
      PRIMARY KEY (datasource_id, sample_key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_datasource_samples_at ON datasource_samples(datasource_id, at)`,
  ],
};

/**
 * Tracking config, which does sync — the intent belongs to the user, only the samples are local.
 * Kept apart from v3 on purpose: this is the first migration in the project to alter a CRR table,
 * so `crsql_begin_alter`/`crsql_commit_alter` run here with nothing else in the transaction to
 * confuse a failure. All three columns are nullable, per the CRR rules in §2.3.
 */
const v4: Migration = {
  version: 4,
  statements: [
    `ALTER TABLE datasources ADD COLUMN track_mode TEXT`,
    `ALTER TABLE datasources ADD COLUMN track_key TEXT`,
    `ALTER TABLE datasources ADD COLUMN track_limit INTEGER`,
  ],
  alteredCrrTables: ["datasources"],
};

export const MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
