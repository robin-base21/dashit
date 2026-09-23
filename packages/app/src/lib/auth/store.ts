/**
 * A tiny IndexedDB key/value store for auth state.
 *
 * IndexedDB rather than localStorage because Phase 3 keeps the device key here as a
 * non-extractable `CryptoKey`, which only IndexedDB can hold — putting the refresh token in the
 * same place now avoids moving it later.
 */
const DB_NAME = "dashit-auth";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    return ((await withStore<T>("readonly", (s) => s.get(key) as IDBRequest<T>)) ?? null) as T | null;
  } catch {
    // A blocked or cleared origin just means "not signed in"; it must never break startup.
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.put(value, key) as IDBRequest<unknown>);
  } catch {
    // Ignored for the same reason.
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
  } catch {
    // Ignored for the same reason.
  }
}
