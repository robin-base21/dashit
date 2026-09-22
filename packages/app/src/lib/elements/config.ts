import { AGGREGATION_FNS, type AggregationConfig } from "shared";

export function parseAggregationConfig(json: string): AggregationConfig {
  try {
    const raw = JSON.parse(json) as Partial<AggregationConfig>;
    const fn = AGGREGATION_FNS.includes(raw.fn as never) ? raw.fn! : "count";
    const cfg: AggregationConfig = { fn };
    if (typeof raw.field === "string" && raw.field) cfg.field = raw.field;
    if (raw.filter && typeof raw.filter.field === "string") cfg.filter = raw.filter;
    return cfg;
  } catch {
    return { fn: "count" };
  }
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
