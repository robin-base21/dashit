import { beforeEach, describe, expect, test } from "bun:test";
import { activeDatasources, buildGraph } from "../src/graph.ts";
import type { LocalStore } from "../src/local-store.ts";
import { migrate } from "../src/migrate.ts";
import { ensureDefaultDashboard } from "../src/repo/dashboards.ts";
import { createDatasource, deleteDatasource } from "../src/repo/datasources.ts";
import { addEdge, CycleError, listEdges } from "../src/repo/edges.ts";
import {
  createElement,
  deleteElement,
  listPlacements,
  listVisibleElementIds,
  placeElement,
  setPlacementHidden,
  unplaceElement,
} from "../src/repo/elements.ts";
import { createTransformer, listTransformerVersions, saveTransformerVersion } from "../src/repo/transformers.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

let store: LocalStore;
let dashboard: string;

beforeEach(async () => {
  store = new BunSqliteStore();
  await migrate(store, { crr: false });
  dashboard = await ensureDefaultDashboard(store);
});

async function count(sql: string, params: string[] = []): Promise<number> {
  const [row] = await store.query<{ n: number }>(sql, params);
  return row!.n;
}

describe("placements", () => {
  test("place, hide, unplace, re-place", async () => {
    const el = await createElement(store, { kind: "task", title: "Todo" });
    expect(await listVisibleElementIds(store)).toEqual([]);

    await placeElement(store, el, { dashboard_id: dashboard, x: 0, y: 0, w: 4, h: 3 });
    expect(await listVisibleElementIds(store)).toEqual([el]);

    await setPlacementHidden(store, el, true);
    expect(await listVisibleElementIds(store)).toEqual([]);
    expect(await listPlacements(store, dashboard)).toHaveLength(1);

    await unplaceElement(store, el);
    expect(await listPlacements(store, dashboard)).toHaveLength(0);

    await placeElement(store, el, { dashboard_id: dashboard, x: 2, y: 1, w: 2, h: 2 });
    const [p] = await listPlacements(store, dashboard);
    expect(p).toMatchObject({ x: 2, y: 1, w: 2, h: 2, hidden: 0, deleted_at: null });
  });
});

describe("deleteElement cascade", () => {
  test("tombstones placement, edges, and kind rows", async () => {
    const table = await createElement(store, { kind: "table" });
    await placeElement(store, table, { dashboard_id: dashboard, x: 0, y: 0, w: 4, h: 3 });
    await store.exec(`INSERT INTO table_columns (id, element_id, name) VALUES ('c1', ?, 'A')`, [table]);
    await store.exec(`INSERT INTO table_rows (id, element_id) VALUES ('r1', ?)`, [table]);
    await store.exec(`INSERT INTO table_cells (row_id, column_id, value_json) VALUES ('r1', 'c1', '1')`);

    const ds = await createDatasource(store, { kind: "internal", name: "t", source_element_id: table });
    const chart = await createElement(store, { kind: "chart" });
    await addEdge(store, { producer_kind: "datasource", producer_id: ds, consumer_kind: "element", consumer_id: chart });

    await deleteElement(store, chart);
    expect(await listEdges(store)).toHaveLength(0);

    await deleteElement(store, table);
    expect(await count(`SELECT count(*) n FROM elements WHERE deleted_at IS NULL`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM placements WHERE deleted_at IS NULL`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM table_columns WHERE deleted_at IS NULL`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM table_rows WHERE deleted_at IS NULL`)).toBe(0);
    // cells are orphaned, not deleted
    expect(await count(`SELECT count(*) n FROM table_cells`)).toBe(1);
    // the internal datasource stays; it is now unbound
    expect(await count(`SELECT count(*) n FROM datasources WHERE deleted_at IS NULL`)).toBe(1);
  });
});

describe("edges and graph", () => {
  test("rejects cycles across transformers", async () => {
    const ds = await createDatasource(store, { kind: "static", name: "s", value: [1, 2, 3] });
    const { transformer_id: t1 } = await createTransformer(store, { name: "t1", code: "return inputs[0]", site_id: "s" });
    const { transformer_id: t2 } = await createTransformer(store, { name: "t2", code: "return inputs[0]", site_id: "s" });

    await addEdge(store, { producer_kind: "datasource", producer_id: ds, consumer_kind: "transformer", consumer_id: t1 });
    await addEdge(store, { producer_kind: "transformer", producer_id: t1, consumer_kind: "transformer", consumer_id: t2 });

    await expect(
      addEdge(store, { producer_kind: "transformer", producer_id: t2, consumer_kind: "transformer", consumer_id: t1 }),
    ).rejects.toBeInstanceOf(CycleError);
    await expect(
      addEdge(store, { producer_kind: "transformer", producer_id: t1, consumer_kind: "transformer", consumer_id: t1 }),
    ).rejects.toBeInstanceOf(CycleError);
    expect(await listEdges(store)).toHaveLength(2);
  });

  test("active datasources follow visibility through transformers", async () => {
    const dsA = await createDatasource(store, { kind: "static", name: "a", value: 1 });
    const dsB = await createDatasource(store, { kind: "static", name: "b", value: 2 });
    const { transformer_id: t } = await createTransformer(store, { name: "t", code: "", site_id: "s" });
    const chart = await createElement(store, { kind: "chart" });
    const agg = await createElement(store, { kind: "aggregation" });

    await addEdge(store, { producer_kind: "datasource", producer_id: dsA, consumer_kind: "transformer", consumer_id: t });
    await addEdge(store, { producer_kind: "transformer", producer_id: t, consumer_kind: "element", consumer_id: chart });
    await addEdge(store, { producer_kind: "datasource", producer_id: dsB, consumer_kind: "element", consumer_id: agg });

    const active = async () => activeDatasources(buildGraph(await listEdges(store)), await listVisibleElementIds(store));

    expect(await active()).toEqual(new Set());

    await placeElement(store, chart, { dashboard_id: dashboard, x: 0, y: 0, w: 4, h: 3 });
    expect(await active()).toEqual(new Set([dsA]));

    await placeElement(store, agg, { dashboard_id: dashboard, x: 4, y: 0, w: 2, h: 2 });
    expect(await active()).toEqual(new Set([dsA, dsB]));

    await setPlacementHidden(store, chart, true);
    expect(await active()).toEqual(new Set([dsB]));

    await deleteDatasource(store, dsB);
    expect(await active()).toEqual(new Set());
  });
});

describe("transformers", () => {
  test("versions are append-only and current pointer moves", async () => {
    const { transformer_id, version_id } = await createTransformer(store, { name: "t", code: "v1", site_id: "site" });
    const v2 = await saveTransformerVersion(store, { transformer_id, code: "v2", site_id: "site", note: "manual edit" });

    const versions = await listTransformerVersions(store, transformer_id);
    expect(versions.map((v) => v.code)).toEqual(["v2", "v1"]);
    expect(versions[1]!.id).toBe(version_id);

    const [t] = await store.query<{ current_version_id: string }>(`SELECT current_version_id FROM transformers WHERE id = ?`, [
      transformer_id,
    ]);
    expect(t!.current_version_id).toBe(v2);
  });
});
