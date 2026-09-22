import {
  createDashboard,
  createElement,
  migrate,
  placeElement,
  SCHEMA_VERSION,
  type LocalStore,
  updateElement,
} from "shared";
import { openStore, opfsAvailable, opfsSupported, resetOpfs, type Vfs } from "$lib/db/open";

export interface VfsResult {
  vfs: Vfs;
  supported: boolean;
  error?: string;
  schemaVersion?: number;
  markerBefore?: string | null;
  markerAfter?: string;
  cellsBefore?: number;
  cellsAfter?: number;
  writeMs?: number;
  readMs?: number;
}

export interface MergeResult {
  ok: boolean;
  error?: string;
  changesFromA?: number;
  titleOnB?: string;
  concurrentMerge?: { title: string; config: string };
}

export interface SpikeReport {
  userAgent: string;
  schemaVersion: number;
  opfsSupported: boolean;
  vfs: VfsResult[];
  merge: MergeResult;
}

const CELLS = 10_000;
const BATCH = 500;

function progress(stage: string): void {
  self.postMessage({ progress: stage, at: Date.now() });
}

async function persistence(vfs: Vfs, marker: string, tag: string): Promise<VfsResult> {
  const result: VfsResult = { vfs, supported: true };
  if (vfs === "opfs-ahp" && !(await opfsAvailable())) return { vfs, supported: false, error: opfsSupported() ? "API present but unusable" : undefined };

  let store: LocalStore | undefined;
  try {
    progress(`${vfs}: open`);
    store = await openStore(`spike-${tag}.db`, vfs);
    progress(`${vfs}: migrate`);
    result.schemaVersion = await migrate(store, { crr: true });
    progress(`${vfs}: migrated`);

    const [before] = await store.query<{ value: string | null }>(`SELECT value FROM local_meta WHERE key = 'marker'`);
    result.markerBefore = before?.value ?? null;
    const [c0] = await store.query<{ n: number }>(`SELECT count(*) AS n FROM table_cells`);
    result.cellsBefore = c0!.n;

    await store.exec(
      `INSERT INTO local_meta (key, value) VALUES ('marker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [marker],
    );
    result.markerAfter = marker;

    if (result.cellsBefore === 0) {
      const t0 = performance.now();
      await store.transaction(async (tx) => {
        await tx.exec(`INSERT INTO table_rows (id, element_id) VALUES ('spike-row', 'spike-table')`);
        for (let i = 0; i < CELLS; i += BATCH) {
          const params: (string | number)[] = [];
          const values: string[] = [];
          for (let j = i; j < i + BATCH; j++) {
            values.push("(?, ?, ?, ?)");
            params.push(`r${j}`, "c", JSON.stringify(j), Date.now());
          }
          await tx.exec(`INSERT INTO table_cells (row_id, column_id, value_json, updated_at) VALUES ${values.join(",")}`, params);
        }
      });
      result.writeMs = Math.round(performance.now() - t0);
      progress(`${vfs}: wrote ${CELLS} cells in ${result.writeMs}ms`);
    }

    const t1 = performance.now();
    const [c1] = await store.query<{ n: number }>(`SELECT count(*) AS n FROM table_cells`);
    result.cellsAfter = c1!.n;
    result.readMs = Math.round(performance.now() - t1);
  } catch (e) {
    result.error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e);
  } finally {
    await store?.close().catch(() => {});
  }
  return result;
}

async function mergeTest(): Promise<MergeResult> {
  try {
    progress("merge: start");
    const a = await openStore("a", "memory");
    const b = await openStore("b", "memory");
    await migrate(a, { crr: true });
    await migrate(b, { crr: true });

    const dash = await createDashboard(a, { name: "A" });
    const el = await createElement(a, { kind: "checklist", title: "from A" });
    await placeElement(a, el, { dashboard_id: dash, x: 1, y: 2, w: 3, h: 4 });

    const changes = await a.changesSince(0);
    await b.applyChanges(changes);
    const [rowB] = await b.query<{ title: string }>(`SELECT title FROM elements WHERE id = ?`, [el]);

    // Concurrent edits to different columns of the same row must both survive.
    const vA = await a.dbVersion();
    const vB = await b.dbVersion();
    await updateElement(a, el, { title: "title from A" });
    await updateElement(b, el, { config: { from: "B" } });
    await b.applyChanges(await a.changesSince(vA));
    await a.applyChanges(await b.changesSince(vB));

    const [mergedA] = await a.query<{ title: string; config_json: string }>(
      `SELECT title, config_json FROM elements WHERE id = ?`,
      [el],
    );
    const [mergedB] = await b.query<{ title: string; config_json: string }>(
      `SELECT title, config_json FROM elements WHERE id = ?`,
      [el],
    );
    const converged =
      mergedA!.title === mergedB!.title && mergedA!.config_json === mergedB!.config_json;

    await a.close();
    await b.close();
    return {
      ok: rowB?.title === "from A" && converged && mergedA!.title === "title from A" && mergedA!.config_json === '{"from":"B"}',
      changesFromA: changes.length,
      titleOnB: rowB?.title,
      concurrentMerge: { title: mergedA!.title, config: mergedA!.config_json },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e) };
  }
}

self.onmessage = async (ev: MessageEvent<{ marker: string; reset: boolean }>) => {
  if (ev.data.reset) {
    await resetOpfs();
    progress("opfs reset");
  }
  const report: SpikeReport = {
    userAgent: navigator.userAgent,
    schemaVersion: SCHEMA_VERSION,
    opfsSupported: await opfsAvailable(),
    vfs: [await persistence("opfs-ahp", ev.data.marker, "opfs"), await persistence("idb", ev.data.marker, "idb")],
    merge: await mergeTest(),
  };
  progress("done");
  self.postMessage({ report });
};
