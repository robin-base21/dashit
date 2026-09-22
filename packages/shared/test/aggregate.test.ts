import { describe, expect, test } from "bun:test";
import { aggregate, fieldsOf, toRecords } from "../src/aggregate.ts";

const rows = [
  { name: "a", qty: 3, done: true },
  { name: "b", qty: "5", done: false },
  { name: "c", qty: null, done: true },
];

describe("aggregate", () => {
  test("count records and count numeric field values", () => {
    expect(aggregate(rows, { fn: "count" })).toBe(3);
    expect(aggregate(rows, { fn: "count", field: "qty" })).toBe(2);
  });

  test("sum/avg/min/max coerce numeric strings and booleans", () => {
    expect(aggregate(rows, { fn: "sum", field: "qty" })).toBe(8);
    expect(aggregate(rows, { fn: "avg", field: "qty" })).toBe(4);
    expect(aggregate(rows, { fn: "min", field: "qty" })).toBe(3);
    expect(aggregate(rows, { fn: "max", field: "qty" })).toBe(5);
    expect(aggregate(rows, { fn: "sum", field: "done" })).toBe(2);
  });

  test("filter and empty results", () => {
    expect(aggregate(rows, { fn: "count", filter: { field: "done", equals: true } })).toBe(2);
    expect(aggregate([], { fn: "avg", field: "qty" })).toBeNull();
    expect(aggregate(null, { fn: "count" })).toBe(0);
  });

  test("scalars and scalar arrays become {value} records", () => {
    expect(toRecords([1, 2, 3])).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(aggregate([1, 2, 3], { fn: "sum" })).toBe(6);
    expect(aggregate(42, { fn: "max" })).toBe(42);
    expect(fieldsOf(rows)).toEqual(["name", "qty", "done"]);
  });
});
