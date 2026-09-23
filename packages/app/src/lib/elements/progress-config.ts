import { aggregate, AGGREGATION_FNS, type AggregationConfig } from "shared";
import { formatNumber } from "./config.ts";

export const PROGRESS_DISPLAYS = ["percent", "ratio"] as const;
export type ProgressDisplay = (typeof PROGRESS_DISPLAYS)[number];

export interface ProgressConfig {
  /** Numerator, aggregated over the bound dataset. */
  value: AggregationConfig;
  /** Denominator: a fixed number, or aggregated over the same dataset. */
  total: number | AggregationConfig;
  /** Only changes the readout — the bar fills by value/total either way. */
  display: ProgressDisplay;
}

const DEFAULT_VALUE: AggregationConfig = { fn: "count" };
/** Counting rows is the denominator people reach for first, so it is the default. */
const DEFAULT_TOTAL: AggregationConfig = { fn: "count" };

export const DEFAULT_PROGRESS: ProgressConfig = {
  value: DEFAULT_VALUE,
  total: DEFAULT_TOTAL,
  display: "percent",
};

function parseAggregation(raw: unknown, fallback: AggregationConfig): AggregationConfig {
  if (raw === null || typeof raw !== "object") return fallback;
  const r = raw as Partial<AggregationConfig>;
  if (!AGGREGATION_FNS.includes(r.fn as never)) return fallback;
  const cfg: AggregationConfig = { fn: r.fn! };
  if (typeof r.field === "string" && r.field) cfg.field = r.field;
  if (r.filter && typeof r.filter.field === "string") cfg.filter = r.filter;
  return cfg;
}

export function parseProgressConfig(json: string): ProgressConfig {
  try {
    const raw = JSON.parse(json) as Partial<ProgressConfig>;
    return {
      value: parseAggregation(raw.value, DEFAULT_VALUE),
      // A fixed total is any finite number, including 0 — which is a real (if useless) setting,
      // so it must survive the round trip rather than being treated as absent.
      total:
        typeof raw.total === "number" && Number.isFinite(raw.total)
          ? raw.total
          : parseAggregation(raw.total, DEFAULT_TOTAL),
      display: PROGRESS_DISPLAYS.includes(raw.display as never) ? raw.display! : DEFAULT_PROGRESS.display,
    };
  } catch {
    return DEFAULT_PROGRESS;
  }
}

export interface ProgressValues {
  /** Numerator, or null when the data holds nothing numeric. */
  value: number | null;
  total: number | null;
  /** 0–1 for the bar, clamped; null when it cannot be computed. */
  fraction: number | null;
  /** What the element reads out: "72%" or "30 / 45". */
  label: string;
}

/**
 * Resolves a progress config against a dataset. Pure, so the awkward cases have somewhere to be
 * tested: an absent or zero total never divides, an overrun clamps the bar but still reports the
 * real numbers rather than quietly capping them, and a negative value floors at empty.
 */
export function progressValues(data: unknown, config: ProgressConfig): ProgressValues {
  const value = aggregate(data, config.value);
  const total = typeof config.total === "number" ? config.total : aggregate(data, config.total);

  const computable = value !== null && total !== null && total !== 0;
  const fraction = computable ? Math.min(1, Math.max(0, value / total)) : null;

  let label: string;
  if (config.display === "ratio") {
    label = `${value === null ? "—" : formatNumber(value)} / ${total === null ? "—" : formatNumber(total)}`;
  } else {
    label = fraction === null ? "—" : `${formatNumber(Math.round(fraction * 1000) / 10)}%`;
  }
  return { value, total, fraction, label };
}
