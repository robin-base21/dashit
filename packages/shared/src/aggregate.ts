export const AGGREGATION_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregationFn = (typeof AGGREGATION_FNS)[number];

export interface AggregationConfig {
  fn: AggregationFn;
  /** Record field to aggregate; ignored for count without a field (counts records). */
  field?: string;
  /** Optional filter: only records where `filter.field` equals `filter.equals`. */
  filter?: { field: string; equals: unknown };
}

/** Numeric view of a value: numbers, numeric strings, booleans (1/0); everything else is skipped. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalizes a dataset value to an array of records (arrays of scalars become {value} records). */
export function toRecords(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((d) => (d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : { value: d }));
  }
  if (data !== null && typeof data === "object") return [data as Record<string, unknown>];
  if (data === undefined || data === null) return [];
  return [{ value: data }];
}

export function fieldsOf(data: unknown): string[] {
  const keys = new Set<string>();
  for (const r of toRecords(data)) for (const k of Object.keys(r)) keys.add(k);
  return [...keys];
}

export function aggregate(data: unknown, config: AggregationConfig): number | null {
  let records = toRecords(data);
  if (config.filter) {
    const { field, equals } = config.filter;
    records = records.filter((r) => r[field] === equals);
  }
  if (config.fn === "count" && !config.field) return records.length;

  const values = config.field
    ? records.map((r) => toNumber(r[config.field!])).filter((n): n is number => n !== null)
    : records.map((r) => toNumber(r.value)).filter((n): n is number => n !== null);

  switch (config.fn) {
    case "count":
      return values.length;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    case "min":
      return values.length ? Math.min(...values) : null;
    case "max":
      return values.length ? Math.max(...values) : null;
  }
}
