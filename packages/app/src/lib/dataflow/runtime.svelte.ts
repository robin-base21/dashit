import { decodeSecrets, extractPath, MIN_POLL_INTERVAL_MS, type DatasourceRow } from "shared";
import { SvelteMap } from "svelte/reactivity";
import type { Db } from "$lib/db/client.svelte";

export interface FetchState {
  /** A request is in flight. */
  busy: boolean;
  lastAttemptAt: number | null;
}

/**
 * Owns one poll timer per active external datasource (ARCHITECTURE.md §5.4). Runs on the main
 * thread because it needs `fetch` with the user's headers. Results go to `datasource_cache`; the
 * dataflow engine picks them up through the table-change subscription.
 */
export class DatasourceRuntime {
  readonly states = new SvelteMap<string, FetchState>();

  #db: Db;
  #timers = new Map<string, ReturnType<typeof setInterval>>();
  #sources = new Map<string, DatasourceRow>();
  #active = new Set<string>();
  #paused = typeof document !== "undefined" && document.hidden;
  #onVisibility = () => {
    const hidden = document.hidden;
    if (hidden === this.#paused) return;
    this.#paused = hidden;
    if (!hidden) for (const id of this.#active) void this.fetchNow(id);
  };

  constructor(db: Db) {
    this.#db = db;
  }

  start(): void {
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    for (const t of this.#timers.values()) clearInterval(t);
    this.#timers.clear();
    this.#active.clear();
  }

  /** Called by the engine after every graph load with the current datasources and active ids. */
  sync(datasources: DatasourceRow[], activeIds: Set<string>): void {
    const external = datasources.filter((d) => d.kind === "external");
    const next = new Map(external.map((d) => [d.id, d]));

    for (const id of this.#timers.keys()) {
      const ds = next.get(id);
      if (!ds || !activeIds.has(id) || this.#intervalChanged(ds)) this.#stopTimer(id);
    }
    for (const ds of external) {
      if (!activeIds.has(ds.id)) continue;
      const wasRunning = this.#timers.has(ds.id);
      this.#sources.set(ds.id, ds);
      if (!wasRunning) this.#startTimer(ds);
    }
    this.#sources = next;
    this.#active = new Set([...activeIds].filter((id) => next.has(id)));
  }

  async fetchNow(id: string): Promise<void> {
    const ds = this.#sources.get(id);
    if (!ds || ds.kind !== "external" || !ds.url) return;
    const st = this.states.get(id);
    if (st?.busy) return;
    this.states.set(id, { busy: true, lastAttemptAt: Date.now() });
    try {
      const value = await fetchDatasource(ds);
      await this.#db.call("setDatasourceCache", { datasource_id: id, value });
    } catch (e) {
      await this.#db.call("setDatasourceCache", { datasource_id: id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.states.set(id, { busy: false, lastAttemptAt: Date.now() });
    }
  }

  #intervalChanged(ds: DatasourceRow): boolean {
    const prev = this.#sources.get(ds.id);
    return !!prev && (prev.poll_interval_ms !== ds.poll_interval_ms || prev.url !== ds.url);
  }

  #startTimer(ds: DatasourceRow): void {
    const every = Math.max(MIN_POLL_INTERVAL_MS, ds.poll_interval_ms ?? 60_000);
    if (!this.#paused) void this.fetchNow(ds.id);
    this.#timers.set(
      ds.id,
      setInterval(() => {
        if (!this.#paused) void this.fetchNow(ds.id);
      }, every),
    );
  }

  #stopTimer(id: string): void {
    const t = this.#timers.get(id);
    if (t) clearInterval(t);
    this.#timers.delete(id);
  }
}

/** One request for an external datasource: headers from its secrets, JSON body, optional path. */
export async function fetchDatasource(ds: DatasourceRow, signal?: AbortSignal): Promise<unknown> {
  const { headers } = decodeSecrets(ds.secrets_ciphertext);
  const res = await fetch(ds.url!, { method: ds.method ?? "GET", headers, signal, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const value = extractPath(body, ds.response_path);
  if (value === undefined) throw new Error(`nothing at path ${ds.response_path}`);
  return value;
}
