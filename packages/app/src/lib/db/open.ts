import initWasm, { DB, type SQLite3 } from "@vlcn.io/crsqlite-wasm";
import wasmUrl from "@vlcn.io/crsqlite-wasm/crsqlite.wasm?url";
// @ts-expect-error untyped example VFS shipped with wa-sqlite
import { AccessHandlePoolVFS } from "@vlcn.io/wa-sqlite/src/examples/AccessHandlePoolVFS.js";
import * as SQLite from "@vlcn.io/wa-sqlite";
import { CrSqliteWasmStore } from "./crsqlite-store.ts";

export type Vfs = "opfs-ahp" | "idb" | "memory";

// AccessHandlePoolVFS registers itself under its own `name` getter.
const OPFS_VFS_NAME = "AccessHandlePool";
const IDB_VFS_NAME = "idb-batch-atomic";
const OPFS_DIR = "/dashit-opfs";

/** Deletes every OPFS-backed database. Must run before the VFS is registered. */
export async function resetOpfs(): Promise<void> {
  if (!(await opfsAvailable())) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR.replace(/^\//, ""), { recursive: true });
  } catch {
    // nothing to reset
  }
}

let sqlite: Promise<SQLite3> | null = null;

// SQLite3.base is declared private but is the only handle to the wa-sqlite API object.
function apiOf(s: SQLite3): SQLiteAPI {
  return (s as unknown as { base: SQLiteAPI }).base;
}
let opfsRegistered: Promise<boolean> | null = null;

function getSqlite(): Promise<SQLite3> {
  sqlite ??= initWasm(() => wasmUrl);
  return sqlite;
}

/** OPFS synchronous access handles exist only in dedicated workers. */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof (globalThis as { FileSystemSyncAccessHandle?: unknown }).FileSystemSyncAccessHandle !== "undefined"
  );
}

let opfsProbe: Promise<boolean> | null = null;

/**
 * Feature detection is not enough: WebKit exposes the API but throws UnknownError in
 * ephemeral sessions. Actually open a sync access handle once.
 */
export function opfsAvailable(): Promise<boolean> {
  opfsProbe ??= (async () => {
    if (!opfsSupported()) return false;
    try {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(".dashit-probe", { create: true });
      const handle = await (file as unknown as { createSyncAccessHandle(): Promise<{ close(): void }> }).createSyncAccessHandle();
      handle.close();
      await root.removeEntry(".dashit-probe").catch(() => {});
      return true;
    } catch {
      return false;
    }
  })();
  return opfsProbe;
}

async function ensureOpfsVfs(api: SQLite3): Promise<boolean> {
  opfsRegistered ??= (async () => {
    if (!(await opfsAvailable())) return false;
    const vfs = new AccessHandlePoolVFS(OPFS_DIR);
    await vfs.isReady;
    // The pool is a fixed set of OPFS files; a DB plus its journal/WAL needs headroom.
    if (vfs.getCapacity() - vfs.getSize() < 4) await vfs.addCapacity(4);
    apiOf(api).vfs_register(vfs, false);
    return true;
  })();
  return opfsRegistered;
}

export async function openStore(name: string, vfs: Vfs): Promise<CrSqliteWasmStore> {
  // AccessHandlePoolVFS stores the name in a fixed header; keep names simple.
  if (!/^[A-Za-z0-9_.-]+$/.test(name) && vfs !== "memory") throw new Error(`invalid database name: ${name}`);
  const api = await getSqlite();

  let db: DB;
  if (vfs === "memory") {
    db = await api.open(":memory:");
  } else if (vfs === "idb") {
    db = await api.open(name);
  } else {
    if (!(await ensureOpfsVfs(api))) throw new Error("OPFS sync access handles unavailable");
    const ptr = await apiOf(api).open_v2(
      name,
      SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
      OPFS_VFS_NAME,
    );
    db = new DB(apiOf(api), ptr, name);
    const stmt = await db.prepare(
      `SELECT tbl_name FROM tables_used(?) AS u JOIN sqlite_master ON sqlite_master.name = u.name WHERE u.schema = 'main'`,
    );
    stmt.raw(true);
    db._setTablesUsedStmt(stmt);
    const [[siteHex]] = await db.execA<[string]>(`SELECT hex(crsql_site_id())`);
    db._setSiteid(siteHex!);
  }

  // Statement journals and sort spills default to temp *files*, which cost ~50x in write
  // calls through OPFS (Phase 0 spike: 87k xWrite -> 779 for a 10k-row insert).
  await db.exec(`PRAGMA temp_store = MEMORY`);
  await db.exec(`PRAGMA cache_size = -16000`);

  return new CrSqliteWasmStore(db, db.siteid);
}

export { IDB_VFS_NAME, OPFS_VFS_NAME };
