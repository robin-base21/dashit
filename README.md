# dashit

Local-first dashboard: compose a dashboard from editable elements (task lists, tables) and
observables (charts, aggregations, progress bars) fed by datasources through user-written transformers. Data lives
in SQLite on each device and syncs between devices as encrypted changesets through a thin relay
that never sees plaintext.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and roadmap.

```sh
bun install
bun test               # unit tests
bun run typecheck      # shared + backend
bun run dev            # SvelteKit app
bun run dev:backend    # relay
```
