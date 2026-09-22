import { beforeEach, describe, expect, test } from "bun:test";
import type { LocalStore } from "../src/local-store.ts";
import { migrate } from "../src/migrate.ts";
import { readElementData } from "../src/repo/element-data.ts";
import { createElement, deleteElement } from "../src/repo/elements.ts";
import { commands, isCommandName } from "../src/repo/index.ts";
import {
  addTableColumn,
  addTableRow,
  deleteTableColumn,
  deleteTableRow,
  listTableCells,
  setTableCell,
} from "../src/repo/tables.ts";
import { addTaskItem, deleteTaskItem, listTaskItems, moveTaskItem, updateTaskItem } from "../src/repo/task-items.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

let store: LocalStore;

beforeEach(async () => {
  store = new BunSqliteStore();
  await migrate(store, { crr: false });
});

describe("task items", () => {
  test("ordering, nesting, insertion after, and subtree delete", async () => {
    const el = await createElement(store, { kind: "checklist" });
    const a = await addTaskItem(store, { element_id: el, title: "a" });
    const c = await addTaskItem(store, { element_id: el, title: "c" });
    const b = await addTaskItem(store, { element_id: el, title: "b", after_id: a });
    const b1 = await addTaskItem(store, { element_id: el, title: "b1", parent_id: b });
    const b1x = await addTaskItem(store, { element_id: el, title: "b1x", parent_id: b1 });

    const roots = (await listTaskItems(store, el)).filter((i) => i.parent_id === null).map((i) => i.title);
    expect(roots).toEqual(["a", "b", "c"]);

    await updateTaskItem(store, b1, { done: true, title: "B1" });
    const data = await readElementData(store, el);
    expect(data.find((d) => d.id === b1)).toMatchObject({ title: "B1", done: true, depth: 1 });
    expect(data.find((d) => d.id === b1x)).toMatchObject({ depth: 2 });

    // move c before a at root
    const items = await listTaskItems(store, el);
    const aKey = items.find((i) => i.id === a)!.sort_key;
    await moveTaskItem(store, c, { parent_id: null, before_key: null, after_key: aKey });
    const roots2 = (await listTaskItems(store, el)).filter((i) => i.parent_id === null).map((i) => i.title);
    expect(roots2).toEqual(["c", "a", "b"]);

    await deleteTaskItem(store, b);
    const remaining = (await listTaskItems(store, el)).map((i) => i.title);
    expect(remaining).toEqual(["c", "a"]);
  });

  test("deleting the element tombstones its items", async () => {
    const el = await createElement(store, { kind: "task" });
    await addTaskItem(store, { element_id: el, title: "x" });
    await deleteElement(store, el);
    expect(await listTaskItems(store, el)).toEqual([]);
  });
});

describe("tables", () => {
  test("columns, rows, cells, and dataset projection", async () => {
    const el = await createElement(store, { kind: "table" });
    const name = await addTableColumn(store, { element_id: el, name: "name" });
    const qty = await addTableColumn(store, { element_id: el, name: "qty", data_type: "number" });
    const r1 = await addTableRow(store, { element_id: el, cells: { [name]: "apples", [qty]: 3 } });
    const r2 = await addTableRow(store, { element_id: el, cells: { [name]: "pears" } });
    await setTableCell(store, { row_id: r2, column_id: qty, value: 5 });

    expect(await readElementData(store, el)).toEqual([
      { id: r1, name: "apples", qty: 3 },
      { id: r2, name: "pears", qty: 5 },
    ]);

    await deleteTableColumn(store, qty);
    expect(await readElementData(store, el)).toEqual([
      { id: r1, name: "apples" },
      { id: r2, name: "pears" },
    ]);

    await deleteTableRow(store, r1);
    expect((await readElementData(store, el)).map((r) => r.id)).toEqual([r2]);
    // orphaned cells of the deleted row are excluded from reads but still stored until GC
    expect((await listTableCells(store, el)).every((c) => c.row_id === r2)).toBe(true);
  });

  test("rejects unknown column types", async () => {
    const el = await createElement(store, { kind: "table" });
    await expect(addTableColumn(store, { element_id: el, name: "x", data_type: "blob" as never })).rejects.toThrow();
  });
});

describe("commands map", () => {
  test("exposes repository functions and nothing else", () => {
    expect(isCommandName("createElement")).toBe(true);
    expect(isCommandName("readElementData")).toBe(true);
    expect(isCommandName("constructor")).toBe(false);
    expect(isCommandName("__proto__")).toBe(false);
    for (const fn of Object.values(commands)) expect(typeof fn).toBe("function");
  });
});
