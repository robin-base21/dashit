import { Database } from "bun:sqlite";
import type { Changeset, LocalStore, SqlValue, Unsubscribe } from "../src/local-store.ts";

/**
 * Plain-SQLite LocalStore for unit tests. No cr-sqlite, so the changeset methods throw;
 * migrate() must be called with { crr: false }.
 */
export class BunSqliteStore implements LocalStore {
  private readonly db: Database;
  private readonly subscribers = new Set<(tables: string[]) => void>();
  private depth = 0;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.exec("PRAGMA foreign_keys = OFF");
  }

  async exec(sql: string, params: SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
    if (this.depth === 0) this.notify();
  }

  async query<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    this.db.exec("BEGIN");
    this.depth++;
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
      this.notify();
    }
  }

  async changesSince(): Promise<Changeset> {
    throw new Error("BunSqliteStore has no cr-sqlite");
  }
  async applyChanges(): Promise<void> {
    throw new Error("BunSqliteStore has no cr-sqlite");
  }
  async exportAll(): Promise<Changeset> {
    throw new Error("BunSqliteStore has no cr-sqlite");
  }
  async dbVersion(): Promise<number> {
    return 0;
  }

  subscribe(_tables: string[], cb: (tables: string[]) => void): Unsubscribe {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private notify(): void {
    for (const cb of this.subscribers) cb([]);
  }
}
