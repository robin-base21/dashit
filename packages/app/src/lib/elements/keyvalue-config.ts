import { toRecords } from "shared";
import { parseIsoLike } from "./chart-config.ts";
import { formatNumber } from "./config.ts";

export interface KeyValueConfig {
  /** Field holding the row's label. Empty means "use each field of the single record". */
  label: string;
  value: string;
  /** Field holding the row's unit, which is what turns formatting from a guess into a rule. */
  metric: string;
}

export const DEFAULT_KEYVALUE: KeyValueConfig = { label: "", value: "", metric: "" };

export function parseKeyValueConfig(json: string): KeyValueConfig {
  try {
    const raw = JSON.parse(json) as Partial<KeyValueConfig>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { label: str(raw.label), value: str(raw.value), metric: str(raw.metric) };
  } catch {
    return DEFAULT_KEYVALUE;
  }
}

export interface KeyValueRow {
  key: string;
  /** Ready to render. */
  display: string;
  /** The untruncated original, for a tooltip, when `display` had to be shortened. */
  title?: string;
}

const MAX_DISPLAY = 80;

/**
 * Rows for the list, in whichever of the two shapes the data arrives as.
 *
 * With label and value fields chosen, each record is a row. Without them, a *single* record has
 * each of its fields turned into a row — which is what a status endpoint returns and needs no
 * configuration at all. Several records and no fields chosen yields nothing, so the view can ask
 * for the fields rather than guess.
 *
 * Note `toRecords` flattens a bare object into one record, so a one-element array of
 * `{name, value}` is indistinguishable from a flat object here and auto-renders as two rows named
 * `name` and `value`. Choosing the fields is the fix; nothing in the data can tell them apart.
 */
export function keyValueRows(data: unknown, config: KeyValueConfig): KeyValueRow[] {
  const records = toRecords(data);
  if (records.length === 0) return [];

  if (config.label && config.value) {
    return records.map((r) => {
      const unit = config.metric ? r[config.metric] : undefined;
      return row(String(r[config.label] ?? ""), r[config.value], unit);
    });
  }
  if (records.length !== 1) return [];
  return Object.entries(records[0]!).map(([key, v]) => row(key, v, undefined));
}

function row(key: string, value: unknown, unit: unknown): KeyValueRow {
  const full = formatValue(value, typeof unit === "string" ? unit : undefined);
  return full.length > MAX_DISPLAY ? { key, display: `${full.slice(0, MAX_DISPLAY)}…`, title: full } : { key, display: full };
}

const BYTE_UNITS = new Set(["b", "byte", "bytes"]);
const MS_UNITS = new Set(["ms", "millisecond", "milliseconds"]);
const SECOND_UNITS = new Set(["s", "sec", "secs", "second", "seconds"]);
/** ISO 4217 codes are three letters; `Intl` rejects anything else, so it is tried in a guard. */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * One value, formatted as well as the data allows. A unit makes this a rule; without one the type
 * is inferred, conservatively enough that identifiers survive intact.
 */
export function formatValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  const n = asNumber(value);
  if (n !== null && unit) return withUnit(n, unit.trim());
  if (n !== null) return formatNumber(n);

  if (typeof value === "string") {
    const date = parseIsoLike(value);
    if (date) return formatDate(date, value);
    return unit ? `${value} ${unit}` : value;
  }
  // An object or array has no sensible single-line form; show it compactly and let the row
  // truncate it with the original on hover.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Numbers, and strings that are unambiguously numbers. The round-trip check is what keeps `"0042"`
 * an identifier and `"1.2.3"` a version rather than mangling either into a number.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && String(n) === t ? n : null;
}

function withUnit(n: number, unit: string): string {
  const u = unit.toLowerCase();

  if (u === "%" || u === "percent") {
    // The one unresolvable guess: a magnitude at or below 1 is read as a fraction, so 0.985 is
    // 98.5%. A genuine 0.9% would therefore read as 90%; nothing in the data can distinguish them.
    const pct = Math.abs(n) <= 1 ? n * 100 : n;
    return `${formatNumber(round(pct, 1))}%`;
  }
  if (BYTE_UNITS.has(u)) return formatBytes(n);
  if (MS_UNITS.has(u)) return formatDuration(n);
  if (SECOND_UNITS.has(u)) return formatDuration(n * 1000);
  if (CURRENCY.test(unit)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: unit }).format(n);
    } catch {
      // Not a currency Intl knows; fall through to the plain form.
    }
  }
  return `${formatNumber(n)} ${unit}`;
}

function formatBytes(n: number): string {
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${formatNumber(round(v, i === 0 ? 0 : 1))} ${units[i]}`;
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const v = Math.abs(ms);
  if (v < 1000) return `${sign}${formatNumber(round(v, 0))} ms`;
  if (v < 60_000) return `${sign}${formatNumber(round(v / 1000, 2))} s`;
  if (v < 3_600_000) {
    const m = Math.floor(v / 60_000);
    return `${sign}${m}m ${Math.round((v % 60_000) / 1000)}s`;
  }
  const h = Math.floor(v / 3_600_000);
  return `${sign}${h}h ${Math.round((v % 3_600_000) / 60_000)}m`;
}

/** A wall-clock date keeps its day by formatting in UTC; a date-time is shown in local terms. */
function formatDate(date: Date, raw: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
