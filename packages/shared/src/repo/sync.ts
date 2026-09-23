import type { Changeset, LocalStore } from "../local-store.ts";
import { SCHEMA_VERSION } from "../schema.ts";

export interface SyncStateRow {
  last_pushed_db_version: number;
  last_pulled_seq: number;
  last_snapshot_seq: number;
  last_sync_ok_at: number | null;
  last_sync_error: string | null;
}

export async function getSyncState(store: LocalStore): Promise<SyncStateRow> {
  const [row] = await store.query<SyncStateRow>(
    `SELECT last_pushed_db_version, last_pulled_seq, last_snapshot_seq, last_sync_ok_at, last_sync_error
     FROM sync_state WHERE id = 1`,
  );
  return row ?? { last_pushed_db_version: 0, last_pulled_seq: 0, last_snapshot_seq: 0, last_sync_ok_at: null, last_sync_error: null };
}

export interface PendingChanges {
  rows: Changeset;
  /** Exclusive lower bound: the watermark these rows follow. */
  from: number;
  /** Highest `db_version` among the rows — the watermark to record once they are acked. */
  to: number;
  schema_version: number;
}

/**
 * This site's un-pushed changes.
 *
 * `to` comes from the rows themselves, never from `dbVersion()`. The global db version advances
 * when *other* sites' changes are applied, so using it as the watermark would skip local edits
 * that happen to carry a lower `db_version` than an applied remote one — a silent hole in what
 * ever reaches the relay.
 */
export async function pendingChanges(store: LocalStore): Promise<PendingChanges> {
  const { last_pushed_db_version } = await getSyncState(store);
  const rows = await store.changesSince(last_pushed_db_version);
  let to = last_pushed_db_version;
  for (const r of rows) if (r.db_version > to) to = r.db_version;
  return { rows, from: last_pushed_db_version, to, schema_version: SCHEMA_VERSION };
}

export async function markPushed(store: LocalStore, toVersion: number): Promise<void> {
  // Never move backwards: envelopes may be acked out of order after a retry.
  await store.exec(
    `UPDATE sync_state SET last_pushed_db_version = ? WHERE id = 1 AND last_pushed_db_version < ?`,
    [toVersion, toVersion],
  );
}

/** Applies a batch of pulled changesets and advances the watermark together, so a crash cannot split them. */
export async function applyPulled(store: LocalStore, batches: Changeset[], seq: number): Promise<void> {
  await store.transaction(async (tx) => {
    for (const rows of batches) if (rows.length > 0) await tx.applyChanges(rows);
    await tx.exec(`UPDATE sync_state SET last_pulled_seq = ? WHERE id = 1 AND last_pulled_seq < ?`, [seq, seq]);
  });
}

/** Everything this database holds, for a snapshot. */
export async function fullChangeset(store: LocalStore): Promise<Changeset> {
  return store.exportAll();
}

export async function markSnapshot(store: LocalStore, seq: number): Promise<void> {
  await store.exec(`UPDATE sync_state SET last_snapshot_seq = ? WHERE id = 1 AND last_snapshot_seq < ?`, [seq, seq]);
}

/**
 * Resets the pull watermark after a snapshot has been applied, so the tail is pulled from where
 * the snapshot ends rather than from a seq that no longer exists.
 */
export async function adoptSnapshot(store: LocalStore, rows: Changeset, coversSeq: number): Promise<void> {
  await store.transaction(async (tx) => {
    if (rows.length > 0) await tx.applyChanges(rows);
    await tx.exec(`UPDATE sync_state SET last_pulled_seq = ?, last_snapshot_seq = ? WHERE id = 1`, [coversSeq, coversSeq]);
  });
}

export async function markSyncResult(store: LocalStore, error: string | null, now: number = Date.now()): Promise<void> {
  await store.exec(`UPDATE sync_state SET last_sync_ok_at = ?, last_sync_error = ? WHERE id = 1`, [
    error === null ? now : null,
    error,
  ]);
}

/**
 * Whether this database holds anything worth offering to merge into an account (§4.8). Counting
 * elements is enough: a dashboard with no elements is what a fresh install already has.
 */
export async function localDataCount(store: LocalStore): Promise<number> {
  const [row] = await store.query<{ n: number }>(`SELECT count(*) AS n FROM elements WHERE deleted_at IS NULL`);
  return row?.n ?? 0;
}

/**
 * Discards local content when the user chooses their account's data instead (§4.8). Tombstones
 * rather than deletes, so the choice propagates to other devices as ordinary changes instead of
 * silently reappearing on the next pull.
 */
export async function discardLocalData(store: LocalStore, now: number = Date.now()): Promise<void> {
  await store.transaction(async (tx) => {
    for (const table of ["elements", "datasources", "transformers", "dashboards"]) {
      await tx.exec(`UPDATE ${table} SET deleted_at = ? WHERE deleted_at IS NULL`, [now]);
    }
    await tx.exec(`UPDATE placements SET deleted_at = ? WHERE deleted_at IS NULL`, [now]);
    await tx.exec(`UPDATE edges SET deleted_at = ? WHERE deleted_at IS NULL`, [now]);
  });
}
