export const CHART_TYPES = ["bar", "line", "area", "pie", "radar", "radial"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_TYPE_LABEL: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  radar: "Radar",
  radial: "Radial",
};

export interface ChartConfig {
  type: ChartType;
  /** Category / x-axis field. */
  x: string;
  /** Value fields (series). Pie/radial use the first one. */
  y: string[];
  horizontal?: boolean;
}

export function parseChartConfig(json: string): ChartConfig {
  try {
    const raw = JSON.parse(json) as Partial<ChartConfig>;
    return {
      type: CHART_TYPES.includes(raw.type as ChartType) ? (raw.type as ChartType) : "bar",
      x: typeof raw.x === "string" ? raw.x : "",
      y: Array.isArray(raw.y) ? raw.y.filter((v): v is string => typeof v === "string") : [],
      horizontal: raw.horizontal === true,
    };
  } catch {
    return { type: "bar", x: "", y: [] };
  }
}

/** Theme palette from layout.css; series cycle through it. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function seriesColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]!;
}
