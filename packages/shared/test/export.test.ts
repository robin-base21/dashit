import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrate.ts";
import { ensureDefaultDashboard } from "../src/repo/dashboards.ts";
import { createElement, listElements, placeElement } from "../src/repo/elements.ts";
import { exportData, importData, ImportError, parseExportFile } from "../src/repo/export.ts";
import { addTableColumn, addTableRow } from "../src/repo/tables.ts";
import { readElementData } from "../src/repo/element-data.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

describe("export/import", () => {
  test("round-trips through JSON and merges by primary key", async () => {
    const a = new BunSqliteStore();
    await migrate(a, { crr: false });
    const dash = await ensureDefaultDashboard(a);
    const table = await createElement(a, { kind: "table", title: "T" });
    await placeElement(a, table, { dashboard_id: dash, x: 1, y: 2, w: 3, h: 4 });
    const col = await addTableColumn(a, { element_id: table, name: "n", data_type: "number" });
    await addTableRow(a, { element_id: table, cells: { [col]: 7 } });

    const json = JSON.parse(JSON.stringify(await exportData(a)));
    const file = parseExportFile(json);

    const b = new BunSqliteStore();
    await migrate(b, { crr: false });
    const summary = await importData(b, file);
    expect(summary.rows).toBeGreaterThanOrEqual(5);
    expect((await listElements(b)).map((e) => e.title)).toEqual(["T"]);
    expect(await readElementData(b, table)).toEqual([{ id: expect.any(String), n: 7 }]);

    // Importing again is idempotent (upsert).
    const again = await importData(b, file);
    expect(again.rows).toBe(summary.rows);
    expect(await listElements(b)).toHaveLength(1);
  });

  test("rejects foreign or newer files", () => {
    expect(() => parseExportFile({ format: "other" })).toThrow(ImportError);
    expect(() => parseExportFile({ format: "dashit-export", version: 1, schema_version: 999, tables: {} })).toThrow(/newer/);
  });
});
