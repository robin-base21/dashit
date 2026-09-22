import type { CommandArgs, CommandName, CommandResult } from "shared";
import { createSubscriber } from "svelte/reactivity";
import type { InitResult, WorkerRequest, WorkerResponse } from "./protocol";

type Listener = { tables: Set<string> | null; cb: (tables: string[]) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class DbError extends Error {
  constructor(
    public readonly remoteName: string,
    message: string,
    public readonly remoteStack?: string,
  ) {
    super(message);
    this.name = remoteName;
  }
}

/** Main-thread handle to the DB worker. Repository functions run inside the worker. */
export class Db {
  /** Resolves once open() has initialised the database. */
  readonly ready: Promise<InitResult>;
  info = $state.raw<InitResult | null>(null);

  #worker: Worker;
  #seq = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #listeners = new Set<Listener>();
  #resolveReady!: (info: InitResult) => void;
  #rejectReady!: (e: Error) => void;
  #opened = false;

  constructor() {
    this.#worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.#onMessage(ev.data);
    this.#worker.onerror = (ev) => {
      for (const p of this.#pending.values()) p.reject(new DbError("WorkerError", ev.message));
      this.#pending.clear();
    };
    this.ready = new Promise<InitResult>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  /** Opens the database. Call only after this tab owns the database lock. */
  open(): Promise<InitResult> {
    if (!this.#opened) {
      this.#opened = true;
      this.#request<InitResult>({ type: "init" }).then(
        (info) => {
          this.info = info;
          this.#resolveReady(info);
        },
        (e: Error) => this.#rejectReady(e),
      );
    }
    return this.ready;
  }

  call<K extends CommandName>(name: K, ...args: CommandArgs<K>): Promise<CommandResult<K>> {
    return this.#request<CommandResult<K>>({ type: "call", name, args });
  }

  /** Fires after commits that touched any of `tables` (all tables when empty). */
  onChange(tables: string[], cb: (tables: string[]) => void): () => void {
    const l: Listener = { tables: tables.length ? new Set(tables) : null, cb };
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  async close(): Promise<void> {
    await this.#request({ type: "close" });
    this.#worker.terminate();
  }

  #request<T>(msg: DistributiveOmit<WorkerRequest, "id">): Promise<T> {
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ id, ...msg });
    });
  }

  #onMessage(msg: WorkerResponse): void {
    if (msg.id === undefined) {
      for (const l of this.#listeners) {
        if (l.tables === null || msg.tables.some((t) => l.tables!.has(t))) l.cb(msg.tables);
      }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new DbError(msg.error.name, msg.error.message, msg.error.stack));
  }
}

export interface LiveQuery<T> {
  readonly value: T | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): Promise<void>;
}

/**
 * A query that re-runs after commits to `tables` (or any table when empty) while something
 * reactive reads it. Subscription starts on first read inside an effect and stops when the
 * last reader is destroyed.
 */
export function liveQuery<T>(db: Db, fn: (db: Db) => Promise<T>, tables: string[] = []): LiveQuery<T> {
  let value = $state.raw<T | undefined>(undefined);
  let error = $state.raw<Error | null>(null);
  let loading = $state(true);
  let generation = 0;

  const run = async () => {
    const g = ++generation;
    try {
      await db.ready;
      const v = await fn(db);
      if (g !== generation) return;
      value = v;
      error = null;
    } catch (e) {
      if (g !== generation) return;
      error = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (g === generation) loading = false;
    }
  };

  const subscribe = createSubscriber(() => {
    void run();
    return db.onChange(tables, () => void run());
  });

  return {
    get value() {
      subscribe();
      return value;
    },
    get loading() {
      subscribe();
      return loading;
    },
    get error() {
      subscribe();
      return error;
    },
    refresh: run,
  };
}
