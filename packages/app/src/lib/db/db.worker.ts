import { commands, ensureDefaultDashboard, isCommandName, migrate, type LocalStore } from "shared";
import { openStore, opfsAvailable, type Vfs } from "./open";
import type { InitResult, WorkerRequest, WorkerResponse } from "./protocol";

const DB_NAME = "dashit.db";

let store: LocalStore | null = null;

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function fail(id: number, e: unknown): void {
  const error =
    e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : { name: "Error", message: String(e) };
  post({ id, ok: false, error });
}

async function init(): Promise<InitResult> {
  if (store) throw new Error("already initialised");
  const vfs: Vfs = (await opfsAvailable()) ? "opfs-ahp" : "idb";
  const s = await openStore(DB_NAME, vfs);
  const schemaVersion = await migrate(s, { crr: true });
  const dashboardId = await ensureDefaultDashboard(s);
  s.subscribe([], (tables) => post({ type: "changed", tables }));
  store = s;
  return { vfs, siteId: s.siteId, schemaVersion, dashboardId };
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "init":
        post({ id: msg.id, ok: true, result: await init() });
        break;
      case "call": {
        if (!store) throw new Error("database not initialised");
        if (!isCommandName(msg.name)) throw new Error(`unknown command: ${String(msg.name)}`);
        const fn = commands[msg.name] as (store: LocalStore, ...args: unknown[]) => Promise<unknown>;
        post({ id: msg.id, ok: true, result: await fn(store, ...msg.args) });
        break;
      }
      case "close":
        await store?.close();
        store = null;
        post({ id: msg.id, ok: true, result: null });
        break;
    }
  } catch (e) {
    fail(msg.id, e);
  }
};
