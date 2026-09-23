import { bucket, round, walk } from "./random.ts";

export interface MetricSpec {
  min: number;
  max: number;
  periodMs: number;
  decimals: number;
}

/** The metrics `/series`, `/metrics` and `/query` can emit. */
export const METRICS: Record<string, MetricSpec> = {
  cpu: { min: 4, max: 96, periodMs: 240_000, decimals: 1 },
  memory: { min: 28, max: 92, periodMs: 900_000, decimals: 1 },
  requests: { min: 40, max: 900, periodMs: 180_000, decimals: 0 },
  latency_ms: { min: 18, max: 420, periodMs: 120_000, decimals: 0 },
  errors: { min: 0, max: 24, periodMs: 300_000, decimals: 0 },
};

export const METRIC_NAMES = Object.keys(METRICS);
export const DEFAULT_METRICS = ["cpu", "memory", "requests"];

export function metricAt(name: string, tMs: number): number {
  const spec = METRICS[name] ?? { min: 0, max: 100, periodMs: 300_000, decimals: 2 };
  return walk(`metric:${name}`, tMs, spec);
}

export interface SeriesOptions {
  points: number;
  intervalMs: number;
  metrics: string[];
  now: number;
}

export type Row = Record<string, string | number>;

/**
 * Chart-ready rows: a `t` timestamp, a short `label` for the x axis, and one numeric column per
 * metric. The newest point is the current interval bucket, so polling slides the window.
 */
export function buildSeries({ points, intervalMs, metrics, now }: SeriesOptions): Row[] {
  const latest = bucket(now, intervalMs);
  const rows: Row[] = [];
  for (let i = points - 1; i >= 0; i--) {
    const t = latest - i * intervalMs;
    const row: Row = { t: new Date(t).toISOString(), label: formatLabel(t, intervalMs) };
    for (const name of metrics) row[name] = metricAt(name, t);
    rows.push(row);
  }
  return rows;
}

/** Local `HH:MM` for sub-daily buckets, `YYYY-MM-DD` for daily ones. */
export function formatLabel(tMs: number, intervalMs: number): string {
  const d = new Date(tMs);
  if (intervalMs >= 86_400_000) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const SALES_GROUPS: Record<string, string[]> = {
  region: ["NA", "EU", "APAC", "LATAM", "MEA"],
  quarter: ["Q1", "Q2", "Q3", "Q4"],
  channel: ["Web", "Mobile", "Partner", "Retail", "Direct"],
};

export const DEFAULT_SALES_GROUP = "region";

const SALES_FIELDS: Record<string, MetricSpec> = {
  revenue: { min: 12_000, max: 880_000, periodMs: 1_200_000, decimals: 0 },
  units: { min: 50, max: 4_000, periodMs: 900_000, decimals: 0 },
  orders: { min: 10, max: 900, periodMs: 600_000, decimals: 0 },
};

/** The requested group if it exists, otherwise the default. */
export function resolveSalesGroup(group: string | null | undefined): string {
  return group && group in SALES_GROUPS ? group : DEFAULT_SALES_GROUP;
}

/** Categorical rows — one per group member — for bar, pie, radar and table bindings. */
export function buildSales(group: string, now: number): Row[] {
  const key = resolveSalesGroup(group);
  const labels = SALES_GROUPS[key] ?? [];
  return labels.map((label) => {
    const row: Row = { [key]: label };
    for (const [field, spec] of Object.entries(SALES_FIELDS)) {
      row[field] = walk(`sales:${key}:${label}:${field}`, now, spec);
    }
    return row;
  });
}

/** A single flat object, for aggregations and stat readouts. */
export function buildSnapshot(now: number): Record<string, string | number> {
  return {
    generated_at: new Date(now).toISOString(),
    cpu: metricAt("cpu", now),
    memory: metricAt("memory", now),
    disk: walk("metric:disk", now, { min: 40, max: 88, periodMs: 3_600_000, decimals: 1 }),
    requests_per_min: metricAt("requests", now),
    latency_ms: metricAt("latency_ms", now),
    error_rate: round(metricAt("errors", now) / 100, 4),
    uptime_s: Math.floor(now / 1000) % 2_592_000,
  };
}

/** RFC 4180 CSV of the given rows, taking the column order from the first row. */
export function toCsv(rows: Row[]): string {
  const first = rows[0];
  if (!first) return "";
  const columns = Object.keys(first);
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c] ?? "")).join(","));
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
