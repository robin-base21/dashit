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

/**
 * Most category labels to draw on a band axis.
 *
 * LayerChart turns off its responsive tick count for band scales (`tickSpacing` is null when the
 * scale is a band with no interval), so it renders the whole domain — right for `Q1…Q4`, unreadable
 * for a tracked series of a few hundred timestamps. A numeric `ticks` restores a cap: the domain is
 * subsampled by `ceil(length / n)`, so this is an upper bound and short domains are untouched.
 */
export const MAX_CATEGORY_TICKS = 5;

// Strict on purpose: `Date.parse` accepts "2026" and other bare numbers, so a category column of
// counts or years would otherwise be silently reinterpreted as dates.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The value as a Date when it is an ISO date or date-time, else null. */
export function parseIsoLike(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  if (!ISO_DATE.test(value) && !ISO_DATETIME.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const YEAR = 365 * DAY;

export interface LabelFormatters {
  /** Compact, for tick labels: only the precision the data actually needs. */
  tick: (value: unknown) => string;
  /** Fuller, for a tooltip heading, which has room for the date as well as the time. */
  full: (value: unknown) => string;
}

/**
 * Display formatting for a category column, in the viewer's locale and time zone.
 *
 * Timestamps are *stored* as ISO strings — unambiguous, sortable, locale-free — which is
 * unreadable on an axis. Formatting happens here, at the edge, and never touches the stored value
 * or the band-scale domain key: two instants that format alike must still be two categories.
 *
 * The precision adapts to the data: seconds only when samples are closer together than a minute,
 * a date only when the series spans more than a day, a year only when it spans more than one.
 * A column that is not entirely timestamps is left exactly as it is.
 */
export function labelFormatters(values: unknown[]): LabelFormatters {
  const verbatim = (v: unknown) => String(v ?? "");
  if (values.length === 0) return { tick: verbatim, full: verbatim };

  const dates: Date[] = [];
  for (const v of values) {
    const d = parseIsoLike(v);
    if (!d) return { tick: verbatim, full: verbatim };
    dates.push(d);
  }

  const dateOnly = values.every((v) => typeof v === "string" && ISO_DATE.test(v));
  const times = dates.map((d) => d.getTime());
  const span = Math.max(...times) - Math.min(...times);
  const step = dates.length > 1 ? span / (dates.length - 1) : span;

  const showTime = !dateOnly && step < DAY;
  const showDate = dateOnly || span >= DAY;

  const date: Intl.DateTimeFormatOptions =
    dateOnly || span >= YEAR
      ? { year: "numeric", month: "short", day: "numeric" }
      : { month: "short", day: "numeric" };
  const time: Intl.DateTimeFormatOptions =
    step < MINUTE
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
  // A date with no time is a wall-clock date. It parses as UTC midnight, so rendering it in a
  // negative offset would show the day before.
  const zone: Intl.DateTimeFormatOptions = dateOnly ? { timeZone: "UTC" } : {};

  const tick = new Intl.DateTimeFormat(undefined, { ...(showDate ? date : {}), ...(showTime ? time : {}), ...zone });
  const full = new Intl.DateTimeFormat(undefined, { ...date, ...(dateOnly ? {} : time), ...zone });

  const using = (fmt: Intl.DateTimeFormat) => (v: unknown) => {
    const d = parseIsoLike(v);
    return d ? fmt.format(d) : verbatim(v);
  };
  return { tick: using(tick), full: using(full) };
}

/** Theme palette from layout.css; series cycle through it. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function seriesColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]!;
}
