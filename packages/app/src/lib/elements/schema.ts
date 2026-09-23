import type { ElementKind } from "shared";

export interface SchemaField {
  name: string;
  type: string;
  note: string;
}

export interface KindSchema {
  /** `consumes` for observables, `produces` for editables read as an `internal` datasource. */
  direction: "consumes" | "produces";
  summary: string;
  fields: SchemaField[];
  /** A worked example, pretty-printed in the dialog. */
  example: unknown;
}

const RECORDS = "Every element works on an array of records. A bare value or a single object is wrapped into one record, and an array of scalars becomes { value } rows.";

/**
 * What each element kind expects from — or hands to — the dataflow graph. Observables document the
 * shape a transformer has to produce; editables document the shape they emit when an `internal`
 * datasource reads them (`packages/shared/src/repo/element-data.ts`), which is what a transformer
 * downstream of them receives.
 */
export const SCHEMAS: Record<ElementKind, KindSchema> = {
  task: {
    direction: "produces",
    summary: `One record per item, in tree order. ${RECORDS}`,
    fields: [
      { name: "id", type: "string", note: "The item's UUID." },
      { name: "title", type: "string", note: "The item's text." },
      { name: "done", type: "boolean", note: "Ticked or not. Sums as 1/0, so “sum of done” counts what is finished." },
      { name: "parent_id", type: "string | null", note: "The item this one is nested under; null at the root." },
      { name: "depth", type: "number", note: "Nesting level, 0 at the root." },
      { name: "created_at", type: "number", note: "Epoch milliseconds." },
      { name: "updated_at", type: "number", note: "Epoch milliseconds." },
    ],
    example: [
      { id: "01927…", title: "Buy milk", done: true, parent_id: null, depth: 0, created_at: 1790000000000, updated_at: 1790000000000 },
      { id: "01928…", title: "Skimmed", done: false, parent_id: "01927…", depth: 1, created_at: 1790000001000, updated_at: 1790000001000 },
    ],
  },
  table: {
    direction: "produces",
    summary: `One record per row, keyed by your column names. ${RECORDS}`,
    fields: [
      { name: "id", type: "string", note: "The row's UUID." },
      { name: "<column>", type: "string | number | boolean | null", note: "One entry per column you defined, named after it. Empty cells are null." },
    ],
    example: [
      { id: "01927…", item: "Coffee", amount: 4.5, paid: true },
      { id: "01928…", item: "Beans", amount: 12, paid: false },
    ],
  },
  chart: {
    direction: "consumes",
    summary: `One record per point. ${RECORDS}`,
    fields: [
      { name: "<x field>", type: "string", note: "The category or label axis. ISO timestamps are localized automatically." },
      { name: "<series field>", type: "number", note: "One numeric field per series. Non-numeric values are skipped." },
    ],
    example: [
      { t: "2026-09-23T09:00:00.000Z", cpu: 42, memory: 61 },
      { t: "2026-09-23T09:01:00.000Z", cpu: 48, memory: 60 },
    ],
  },
  aggregation: {
    direction: "consumes",
    summary: `One number, reduced from every record. ${RECORDS}`,
    fields: [
      { name: "<field>", type: "number | boolean", note: "The field to reduce. Booleans count as 1/0; “count” works on any shape and needs no field." },
    ],
    example: [{ done: true }, { done: false }, { done: true }],
  },
  progress: {
    direction: "consumes",
    summary: `Two numbers — a value and a total — each reduced from every record. ${RECORDS}`,
    fields: [
      { name: "<value field>", type: "number | boolean", note: "The numerator. Booleans count as 1/0, so “sum of done” is how many are finished." },
      { name: "<total field>", type: "number", note: "The denominator, when it comes from the data rather than a fixed number. “count” uses the row count." },
    ],
    example: { done: 30, total: 45 },
  },
};
