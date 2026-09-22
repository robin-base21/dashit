import type { DB } from "@vlcn.io/crsqlite-wasm";
import type { TXAsync } from "@vlcn.io/xplat-api";
import type { Changeset, CrsqlChange, LocalStore, SqlValue, Unsubscribe } from "shared";

type Exec = Pick<TXAsync, "exec" | "execO">;

const CHANGES_COLUMNS = `"table", pk, cid, val, col_version, db_version, site_id, cl, seq`;

function bind(params?: SqlValue[]): (string | number | bigint | Uint8Array | null)[] | undefined {
  return params as (string | number | bigint | Uint8Array | null)[] | undefined;
}

/** LocalStore view over a running cr-sqlite transaction; nested transaction() calls run inline. */
class TxStore implements LocalStore {
  constructor(private readonly tx: Exec, private readonly parent: CrSqliteWasmStore) {}

  exec(sql: string, params?: SqlValue[]): Promise<void> {
    return this.tx.exec(sql, bind(params));
  }
  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return ((await this.tx.execO<T & {}>(sql, bind(params))) ?? []) as T[];
  }
  transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T> {
    return fn(this);
  }
  changesSince(since: number): Promise<Changeset> {
    return changesSince(this, since);
  }
  applyChanges(cs: Changeset): Promise<void> {
    return applyChanges(this, cs);
  }
  exportAll(): Promise<Changeset> {
    return exportAll(this);
  }
  dbVersion(): Promise<number> {
    return dbVersion(this);
  }
  subscribe(tables: string[], cb: (tables: string[]) => void): Unsubscribe {
    return this.parent.subscribe(tables, cb);
  }
  close(): Promise<void> {
    return Promise.reject(new Error("cannot close inside a transaction"));
  }
}

async function changesSince(store: LocalStore, since: number): Promise<Changeset> {
  return store.query<CrsqlChange>(
    `SELECT ${CHANGES_COLUMNS} FROM crsql_changes WHERE db_version > ? AND site_id = crsql_site_id() ORDER BY db_version, seq`,
    [since],
  );
}

async function exportAll(store: LocalStore): Promise<Changeset> {
  return store.query<CrsqlChange>(`SELECT ${CHANGES_COLUMNS} FROM crsql_changes ORDER BY db_version, seq`);
}

async function applyChanges(store: LocalStore, cs: Changeset): Promise<void> {
  if (cs.length === 0) return;
  await store.transaction(async (tx) => {
    for (const c of cs) {
      await tx.exec(`INSERT INTO crsql_changes (${CHANGES_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        c.table,
        c.pk,
        c.cid,
        c.val,
        c.col_version,
        c.db_version,
        c.site_id,
        c.cl,
        c.seq,
      ]);
    }
  });
}

async function dbVersion(store: LocalStore): Promise<number> {
  const [row] = await store.query<{ v: number | bigint }>(`SELECT crsql_db_version() AS v`);
  return Number(row?.v ?? 0);
}

interface Subscriber {
  tables: Set<string> | null;
  cb: (tables: string[]) => void;
}

/**
 * Production LocalStore over @vlcn.io/crsqlite-wasm. Lives inside the DB worker.
 * Update notifications are coalesced per macrotask and delivered after commit.
 */
export class CrSqliteWasmStore implements LocalStore {
  private readonly subscribers = new Set<Subscriber>();
  private pendingTables = new Set<string>();
  private flushScheduled = false;
  private readonly offUpdate: () => void;

  constructor(
    readonly db: DB,
    readonly siteId: string,
  ) {
    this.offUpdate = db.onUpdate((_type, _db, table) => {
      this.pendingTables.add(table);
      this.scheduleFlush();
    });
  }

  exec(sql: string, params?: SqlValue[]): Promise<void> {
    return this.db.exec(sql, bind(params));
  }

  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    // execO yields null for statements that produce no rows.
    return ((await this.db.execO<T & {}>(sql, bind(params))) ?? []) as T[];
  }

  async transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T> {
    let result!: T;
    await this.db.tx(async (tx) => {
      result = await fn(new TxStore(tx, this));
    });
    return result;
  }

  changesSince(since: number): Promise<Changeset> {
    return changesSince(this, since);
  }
  applyChanges(cs: Changeset): Promise<void> {
    return applyChanges(this, cs);
  }
  exportAll(): Promise<Changeset> {
    return exportAll(this);
  }
  dbVersion(): Promise<number> {
    return dbVersion(this);
  }

  subscribe(tables: string[], cb: (tables: string[]) => void): Unsubscribe {
    const sub: Subscriber = { tables: tables.length ? new Set(tables) : null, cb };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  async close(): Promise<void> {
    this.offUpdate();
    await this.db.close();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const changed = [...this.pendingTables];
      this.pendingTables = new Set();
      for (const s of this.subscribers) {
        if (s.tables === null || changed.some((t) => s.tables!.has(t))) s.cb(changed);
      }
    }, 0);
  }
}
