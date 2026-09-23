import { describe, expect, test } from "bun:test";
import { ELEMENT_KINDS, isEditable } from "shared";
import { KIND_META } from "../src/lib/elements/kinds.ts";
import { SCHEMAS } from "../src/lib/elements/schema.ts";
import {
  DEFAULT_PROGRESS,
  parseProgressConfig,
  progressValues,
  type ProgressConfig,
} from "../src/lib/elements/progress-config.ts";

const TASKS = [{ done: true }, { done: false }, { done: true }];

describe("parseProgressConfig", () => {
  test("falls back to the default on anything unparseable", () => {
    expect(parseProgressConfig("not json")).toEqual(DEFAULT_PROGRESS);
    expect(parseProgressConfig("{}")).toEqual(DEFAULT_PROGRESS);
  });

  test("keeps a fixed numeric total", () => {
    expect(parseProgressConfig(JSON.stringify({ total: 10 })).total).toBe(10);
  });

  test("keeps a fixed total of zero rather than treating it as absent", () => {
    expect(parseProgressConfig(JSON.stringify({ total: 0 })).total).toBe(0);
  });

  test("keeps an aggregated total", () => {
    expect(parseProgressConfig(JSON.stringify({ total: { fn: "sum", field: "cap" } })).total).toEqual({
      fn: "sum",
      field: "cap",
    });
  });

  test("rejects an unknown function or display", () => {
    const cfg = parseProgressConfig(JSON.stringify({ value: { fn: "median" }, display: "gauge" }));
    expect(cfg.value).toEqual(DEFAULT_PROGRESS.value);
    expect(cfg.display).toBe("percent");
  });

  test("a non-finite total does not become a fixed total", () => {
    expect(parseProgressConfig(JSON.stringify({ total: null })).total).toEqual(DEFAULT_PROGRESS.total);
  });
});

describe("progressValues", () => {
  const cfg = (over: Partial<ProgressConfig> = {}): ProgressConfig => ({ ...DEFAULT_PROGRESS, ...over });

  test("a task list: booleans sum as 1/0 against the row count", () => {
    const c = cfg({ value: { fn: "sum", field: "done" }, total: { fn: "count" } });
    expect(progressValues(TASKS, c)).toMatchObject({ value: 2, total: 3, label: "66.7%" });
    expect(progressValues(TASKS, { ...c, display: "ratio" }).label).toBe("2 / 3");
  });

  test("a fixed total", () => {
    const c = cfg({ value: { fn: "sum", field: "done" }, total: 10, display: "ratio" });
    expect(progressValues(TASKS, c)).toMatchObject({ value: 2, total: 10, fraction: 0.2, label: "2 / 10" });
  });

  test("a single record from a transformer", () => {
    const c = cfg({ value: { fn: "sum", field: "done" }, total: { fn: "sum", field: "total" }, display: "ratio" });
    expect(progressValues({ done: 30, total: 45 }, c)).toMatchObject({ value: 30, total: 45, label: "30 / 45" });
  });

  test("a bare scalar from a transformer", () => {
    const c = cfg({ value: { fn: "sum", field: "value" }, total: 100 });
    expect(progressValues(42, c)).toMatchObject({ value: 42, fraction: 0.42, label: "42%" });
  });

  test("a zero total never divides", () => {
    const v = progressValues(TASKS, cfg({ value: { fn: "count" }, total: 0 }));
    expect(v.fraction).toBeNull();
    expect(v.label).toBe("—");
  });

  test("summing a field with nothing numeric is zero, not null", () => {
    // aggregate() defines sum-of-nothing as 0; only avg/min/max can come back null.
    const v = progressValues([{ a: "x" }], cfg({ value: { fn: "sum", field: "a" }, total: 10 }));
    expect(v.value).toBe(0);
    expect(v.fraction).toBe(0);
  });

  test("an aggregation that cannot produce a number leaves the value null", () => {
    const v = progressValues([{ a: "x" }], cfg({ value: { fn: "avg", field: "a" }, total: 10 }));
    expect(v.value).toBeNull();
    expect(v.fraction).toBeNull();
    expect(v.label).toBe("—");
  });

  test("an overrun clamps the bar but still reports the real numbers", () => {
    const v = progressValues(TASKS, cfg({ value: { fn: "count" }, total: 2, display: "ratio" }));
    expect(v.fraction).toBe(1);
    expect(v.label).toBe("3 / 2");
  });

  test("a negative value floors at empty", () => {
    const v = progressValues([{ n: -5 }], cfg({ value: { fn: "sum", field: "n" }, total: 10 }));
    expect(v.fraction).toBe(0);
    expect(v.label).toBe("0%");
  });

  test("an empty dataset does not crash", () => {
    expect(progressValues([], cfg()).fraction).toBeNull();
  });
});

describe("every element kind is fully described", () => {
  // KIND_META is built with `Object.fromEntries(...) as Record<ElementKind, …>`, so the type does
  // not actually enforce completeness — a kind added without an entry fails only at runtime.
  test("has display metadata", () => {
    for (const kind of ELEMENT_KINDS) {
      expect(KIND_META[kind], `no KIND_META entry for "${kind}"`).toBeDefined();
    }
  });

  test("has a documented data format", () => {
    for (const kind of ELEMENT_KINDS) {
      const schema = SCHEMAS[kind];
      expect(schema, `no SCHEMAS entry for "${kind}"`).toBeDefined();
      expect(schema.fields.length, `"${kind}" documents no fields`).toBeGreaterThan(0);
      expect(schema.example, `"${kind}" has no example`).toBeDefined();
    }
  });

  test("editables document what they produce, observables what they consume", () => {
    for (const kind of ELEMENT_KINDS) {
      expect(SCHEMAS[kind].direction, `wrong direction for "${kind}"`).toBe(
        isEditable(kind) ? "produces" : "consumes",
      );
    }
  });
});
