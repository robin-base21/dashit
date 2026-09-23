# DashIt

Local-first dashboard app. Read `ARCHITECTURE.md` before making design decisions — it is the
source of truth for the data model, sync protocol, auth flows, sandboxing, and the phased roadmap.

## Workspace

Bun workspace (`bun install` at the root; Bun 1.3 uses the isolated linker, so each package has
its own `node_modules`).

- `packages/shared` — driver-agnostic core: `LocalStore` interface, schema/migrations, repositories
  with cascade rules, dataflow graph helpers, ids, sort keys. No DOM, no Bun-only APIs at runtime.
- `packages/app` — SvelteKit 2 / Svelte 5 (runes), Tailwind v4, shadcn-svelte. SPA only
  (`ssr = false`, `adapter-static`). SvelteKit needs Vite; that is expected here.
- `packages/backend` — Hono-on-Bun relay on `bun:sqlite`: accounts, passkeys, sessions.
  The Hono app (`src/app.ts`) is separate from `Bun.serve` so tests drive it via `app.request()`.
  Stores only ciphertext and WebAuthn public keys.
- `packages/dummy_api` — throwaway Bun server of random-but-coherent JSON/CSV/SSE/WS endpoints for
  manual `external` datasource testing. Dev-only; nothing in the product imports it.

## Commands

- `bun test` — all unit tests (shared uses a `bun:sqlite` test double, `migrate(store, { crr: false })`).
- `bun run typecheck` — `tsc` for shared, backend and dummy_api; `bun run check` adds `svelte-check`.
- `bun run dev` — app dev server; `bun run dev:backend` — relay; `bun run dev:dummy` — fake datasource API on :3100 (its browser index lists the endpoints).
- `bun run --filter app e2e` — Playwright (Chromium/Firefox/WebKit) against the dev server; `E2E_BASE_URL=... bunx playwright test` to target a running server. On non-Ubuntu hosts WebKit needs the `mcr.microsoft.com/playwright` Docker image with `--network host`. E2E files end in `.pw.ts` so `bun test` ignores them.

## Rules that are easy to get wrong

- Synced tables must stay CRR-compatible: explicit `PRIMARY KEY NOT NULL`, every non-PK column nullable or
  `DEFAULT`ed, no FOREIGN KEY / CHECK / secondary UNIQUE. `test/migrate.test.ts` enforces this.
- Schema changes are new entries in `MIGRATIONS` (additive only); never edit a shipped migration.
- Deletes are soft (`deleted_at`); cascades live in `packages/shared/src/repo/*`, not in SQL.
- IDs are UUIDv7 via `uuidv7()`; list ordering uses string `sort_key`s from `sort-key.ts`.
- Components never write SQL; they call repository functions from `shared` through `db.call('<command>', ...)` — the DB worker runs `commands` from `packages/shared/src/repo/index.ts`. Reads that must stay fresh use `liveQuery(db, fn, tables)`.
- Any default value that depends on existing rows (names, sort keys) is computed inside the repository transaction, never from UI state.
- `packages/shared/src/repo/*` modules are spread into the RPC `commands` map: export only `(store, ...args) => Promise` functions there; put constants and pure helpers in `packages/shared/src/*.ts`.
- Charts: LayerChart 2.5 simplified components (`BarChart`, `LineChart`, `AreaChart`, `PieChart`, `ArcChart`) inside `ChartUi.Container`; radar uses the declarative `<Chart radial>` + `{#snippet marks()}`. Load the `svelte-layerchart` skill before touching chart code.
- Routes: `src/routes/+layout.svelte` is bare; `(app)/+layout.svelte` owns the DB, dataflow engine and shell. Anything that must not open the database (like `/spike`) lives outside `(app)`.
- Before editing `.svelte`/`.svelte.ts` files load the `svelte-code-writer` skill and run `bunx @sveltejs/mcp svelte-autofixer <file>` on what you changed.
- `crsql_as_crr` / `crsql_begin_alter` / `crsql_commit_alter` must run outside an open transaction (the WASM build fails with "no such savepoint" otherwise); `migrate()` already does this.
- Every `openStore()` sets `PRAGMA temp_store = MEMORY`; without it statement journals go through the VFS and writes are ~50x slower. WAL is unavailable on the OPFS VFS. Database names are `[A-Za-z0-9_.-]` only.
- The relay must never receive plaintext content, datasource payloads, API keys, or the recovery key.
- Passkey PRF output is key material and never leaves the device; the relay stores only `prf_capable`.
- Sync: the relay stores envelopes as opaque blobs (base64 of `cbor(changeset)`) and never parses a
  payload. The push watermark is the max `db_version` of the rows pushed, never `dbVersion()`, which
  advances when other sites' changes are applied. `VITE_DASHIT_PLAINTEXT_SYNC=1` is required for the
  engine to run at all and disappears in Phase 3.
- `BunSqliteStore` has no cr-sqlite, so `changesSince`/`applyChanges` throw: CRDT convergence can only
  be tested in Playwright, not `bun test`.
  There is no DEK until Phase 3, so `wrapped_dek` is null everywhere.
- Signing in is additive: anonymous mode is permanent, so no route guards and no redirect to login.
- WebAuthn e2e needs a CDP virtual authenticator, which is Chromium-only — those tests skip elsewhere.
  `playwright.config.ts` starts the relay as a second web server with `DASHIT_DEV_EMAIL_ECHO=1`
  (codes in responses) and `DASHIT_RELAX_RATE_LIMITS=1` — one shared IP plus a reused server
  would otherwise make a test's result depend on how many ran before it. Both are dev-only.
- Only one relay can hold a port: a stale `bun run dev:backend` will shadow a newer one and the
  app will silently talk to old code. `bun run dev` starts the relay too.

## Bun conventions

Use `bun <file>`, `bun test`, `bun install`, `bunx`. Bun loads `.env` itself. Use `Bun.serve()` /
Hono, `bun:sqlite`, built-in `WebSocket`, `Bun.file`. Backend and shared use `bun:test`.
