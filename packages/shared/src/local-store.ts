export type SqlValue = string | number | bigint | Uint8Array | null;

/** One row of cr-sqlite's `crsql_changes` virtual table. */
export interface CrsqlChange {
  table: string;
  pk: Uint8Array;
  cid: string;
  val: SqlValue;
  col_version: number;
  db_version: number;
  site_id: Uint8Array;
  cl: number;
  seq: number;
}

export type Changeset = CrsqlChange[];

export type Unsubscribe = () => void;

/**
 * The single seam between application logic and the SQLite driver.
 * Everything above this interface (migrations, repositories, sync, dataflow, UI)
 * is driver-agnostic; see ARCHITECTURE.md §2.5.
 */
export interface LocalStore {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T>;

  /** Changes made by this site with db_version > since. */
  changesSince(since: number): Promise<Changeset>;
  /** Idempotent, commutative merge of remote changes. */
  applyChanges(cs: Changeset): Promise<void>;
  /** Full-state changeset for snapshots. */
  exportAll(): Promise<Changeset>;
  dbVersion(): Promise<number>;

  subscribe(tables: string[], cb: (tables: string[]) => void): Unsubscribe;
  close(): Promise<void>;
}

export async function queryOne<T>(
  store: LocalStore,
  sql: string,
  params?: SqlValue[],
): Promise<T | undefined> {
  const rows = await store.query<T>(sql, params);
  return rows[0];
}
