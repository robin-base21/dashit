import { beforeEach, describe, expect, test } from "bun:test";
import type { Changeset, CrsqlChange, LocalStore, SqlValue, Unsubscribe } from "../src/local-store.ts";
import { migrate } from "../src/migrate.ts";
import {
  adoptSnapshot,
  applyPulled,
  discardLocalData,
  getSyncState,
  localDataCount,
  markPushed,
  markSnapshot,
  markSyncResult,
  pendingChanges,
} from "../src/repo/sync.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { createElement } from "../src/repo/elements.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

/**
 * A real SQLite store with scripted changesets. The bun:sqlite double has no cr-sqlite, so the
 * changeset methods are supplied here; everything else is genuinely transactional.
 */
class ScriptedStore implements LocalStore {
  readonly inner = new BunSqliteStore();
  pending: Changeset = [];
  applied: Changeset[] = [];
  exported: Changeset = [];
  /** Deliberately high and wrong: nothing should use it as a watermark. */
  globalVersion = 9_999;

  exec(sql: string, params?: SqlValue[]): Promise<void> {
    return this.inner.exec(sql, params);
  }
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }
  transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T> {
    return this.inner.transaction(() => fn(this));
  }
  async changesSince(since: number): Promise<Changeset> {
    return this.pending.filter((r) => r.db_version > since);
  }
  async applyChanges(cs: Changeset): Promise<void> {
    this.applied.push(cs);
  }
  async exportAll(): Promise<Changeset> {
    return this.exported;
  }
  async dbVersion(): Promise<number> {
    return this.globalVersion;
  }
  subscribe(tables: string[], cb: (tables: string[]) => void): Unsubscribe {
    return this.inner.subscribe(tables, cb);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

const change = (db_version: number, table = "elements"): CrsqlChange => ({
  table,
  pk: new Uint8Array([1]),
  cid: "title",
  val: "x",
  col_version: 1,
  db_version,
  site_id: new Uint8Array([9]),
  cl: 1,
  seq: 0,
});

let store: ScriptedStore;
beforeEach(async () => {
  store = new ScriptedStore();
  await migrate(store, { crr: false });
});

describe("pendingChanges", () => {
  test("takes the watermark from the rows, never from dbVersion()", async () => {
    // The global db version advances when *other* sites' changes are applied, so using it would
    // skip local edits carrying a lower db_version — a silent hole in what reaches the relay.
    store.pending = [change(3), change(7), change(5)];
    const pending = await pendingChanges(store);

    expect(pending.to).toBe(7);
    expect(pending.to).not.toBe(store.globalVersion);
    expect(pending.from).toBe(0);
    expect(pending.schema_version).toBe(SCHEMA_VERSION);
    expect(pending.rows).toHaveLength(3);
  });

  test("resumes above the recorded watermark", async () => {
    store.pending = [change(3), change(7)];
    await markPushed(store, 3);
    const pending = await pendingChanges(store);
    expect(pending.from).toBe(3);
    expect(pending.rows.map((r) => r.db_version)).toEqual([7]);
  });

  test("nothing pending leaves the watermark alone", async () => {
    await markPushed(store, 5);
    const pending = await pendingChanges(store);
    expect(pending.rows).toHaveLength(0);
    expect(pending.to).toBe(5);
  });
});

describe("watermarks", () => {
  test("never move backwards", async () => {
    // Envelopes can be acked out of order after a retry; an older ack must not rewind the mark.
    await markPushed(store, 10);
    await markPushed(store, 4);
    expect((await getSyncState(store)).last_pushed_db_version).toBe(10);

    await markSnapshot(store, 20);
    await markSnapshot(store, 8);
    expect((await getSyncState(store)).last_snapshot_seq).toBe(20);
  });

  test("applying a batch advances the pull mark with it", async () => {
    await applyPulled(store, [[change(1)], [change(2)]], 12);
    expect(store.applied).toHaveLength(2);
    expect((await getSyncState(store)).last_pulled_seq).toBe(12);
  });

  test("an empty batch still advances the mark, so an idle pull is not repeated", async () => {
    await applyPulled(store, [], 5);
    expect(store.applied).toHaveLength(0);
    expect((await getSyncState(store)).last_pulled_seq).toBe(5);
  });

  test("a snapshot resets the pull mark to where it ends", async () => {
    await applyPulled(store, [[change(1)]], 30);
    await adoptSnapshot(store, [change(1), change(2)], 12);
    const state = await getSyncState(store);
    // Not "never backwards" here: the snapshot *replaces* position, it does not extend it.
    expect(state.last_pulled_seq).toBe(12);
    expect(state.last_snapshot_seq).toBe(12);
  });

  test("records success and failure for the status line", async () => {
    await markSyncResult(store, "boom", 1000);
    let state = await getSyncState(store);
    expect(state.last_sync_error).toBe("boom");
    expect(state.last_sync_ok_at).toBeNull();

    await markSyncResult(store, null, 2000);
    state = await getSyncState(store);
    expect(state.last_sync_error).toBeNull();
    expect(state.last_sync_ok_at).toBe(2000);
  });
});

describe("adoption", () => {
  test("counts what is worth offering to merge", async () => {
    expect(await localDataCount(store)).toBe(0);
    await createElement(store, { kind: "task", title: "Chores" });
    await createElement(store, { kind: "chart", title: "Sales" });
    expect(await localDataCount(store)).toBe(2);
  });

  test("discarding tombstones rather than deletes, so the choice propagates", async () => {
    // A hard delete would simply reappear on the next pull from another device.
    await createElement(store, { kind: "task", title: "Chores" });
    await discardLocalData(store, 5000);

    expect(await localDataCount(store)).toBe(0);
    const [row] = await store.query<{ deleted_at: number }>(`SELECT deleted_at FROM elements LIMIT 1`);
    expect(row?.deleted_at).toBe(5000);
  });
});
