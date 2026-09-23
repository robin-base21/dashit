import { describe, expect, test } from "bun:test";
import { extractPath } from "shared";
import { buildSales, buildSeries, buildSnapshot, METRICS, METRIC_NAMES, metricAt, toCsv } from "../src/data.ts";
import { bucket, smooth } from "../src/random.ts";

const NOW = Date.UTC(2026, 8, 23, 10, 30, 0);

describe("random", () => {
  test("is deterministic for the same instant", () => {
    expect(metricAt("cpu", NOW)).toBe(metricAt("cpu", NOW));
  });

  test("stays inside the metric's range", () => {
    for (const [name, spec] of Object.entries(METRICS)) {
      for (let i = 0; i < 200; i++) {
        const v = metricAt(name, NOW + i * 37_000);
        expect(v).toBeGreaterThanOrEqual(spec.min);
        expect(v).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  test("moves, but smoothly", () => {
    const step = METRICS.cpu!.periodMs / 20;
    const values = Array.from({ length: 40 }, (_, i) => metricAt("cpu", NOW + i * step));
    expect(new Set(values).size).toBeGreaterThan(20);
    for (let i = 1; i < values.length; i++) {
      expect(Math.abs(values[i]! - values[i - 1]!)).toBeLessThan(30);
    }
  });

  test("interpolates between integer steps", () => {
    const mid = smooth("seed", 3.5);
    const lo = Math.min(smooth("seed", 3), smooth("seed", 4));
    const hi = Math.max(smooth("seed", 3), smooth("seed", 4));
    expect(mid).toBeGreaterThanOrEqual(lo);
    expect(mid).toBeLessThanOrEqual(hi);
  });

  test("buckets onto the interval grid", () => {
    expect(bucket(NOW + 12_345, 60_000)).toBe(bucket(NOW + 30_000, 60_000));
  });
});

describe("series", () => {
  test("returns chart-ready rows ending at the current bucket", () => {
    const rows = buildSeries({ points: 5, intervalMs: 60_000, metrics: ["cpu", "memory"], now: NOW });
    expect(rows).toHaveLength(5);
    const last = rows.at(-1)!;
    expect(last.t).toBe(new Date(bucket(NOW, 60_000)).toISOString());
    expect(Object.keys(last)).toEqual(["t", "label", "cpu", "memory"]);
    expect(typeof last.cpu).toBe("number");
  });

  test("slides by one point after a full interval", () => {
    const a = buildSeries({ points: 4, intervalMs: 60_000, metrics: ["cpu"], now: NOW });
    const b = buildSeries({ points: 4, intervalMs: 60_000, metrics: ["cpu"], now: NOW + 60_000 });
    expect(b.slice(0, 3)).toEqual(a.slice(1));
  });

  test("labels daily buckets as dates", () => {
    const rows = buildSeries({ points: 2, intervalMs: 86_400_000, metrics: ["cpu"], now: NOW });
    expect(rows[0]!.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("sales", () => {
  test("one row per group member, with the group as the x field", () => {
    const rows = buildSales("region", NOW);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.region).toBe("NA");
    expect(Object.keys(rows[0]!)).toEqual(["region", "revenue", "units", "orders"]);
  });

  test("falls back to regions for an unknown group", () => {
    expect(buildSales("nope", NOW)).toEqual(buildSales("region", NOW));
  });

  test("csv quotes and round-trips the header", () => {
    const csv = toCsv(buildSales("quarter", NOW));
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("quarter,revenue,units,orders");
    expect(lines).toHaveLength(5);
  });

  test("csv of no rows is empty", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("snapshot", () => {
  test("is a flat object of numbers plus a timestamp", () => {
    const snap = buildSnapshot(NOW);
    expect(snap.generated_at).toBe(new Date(NOW).toISOString());
    expect(snap.error_rate).toBeLessThanOrEqual(0.24);
    for (const [k, v] of Object.entries(snap)) {
      if (k !== "generated_at") expect(typeof v).toBe("number");
    }
  });
});

describe("datasource compatibility", () => {
  test("the nested envelope resolves through both response_path forms", () => {
    const envelope = { status: "ok", data: { series: buildSeries({ points: 3, intervalMs: 60_000, metrics: ["cpu"], now: NOW }) } };
    expect(extractPath(envelope, "/data/series")).toHaveLength(3);
    expect(extractPath(envelope, "data.series")).toHaveLength(3);
  });

  test("every metric name has a spec", () => {
    expect(METRIC_NAMES.every((n) => METRICS[n] !== undefined)).toBe(true);
  });
});
