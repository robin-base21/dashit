export const ELEMENT_KINDS = ["task", "table", "chart", "aggregation", "progress", "keyvalue"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const EDITABLE_KINDS = ["task", "table"] as const satisfies readonly ElementKind[];
export const OBSERVABLE_KINDS = ["chart", "aggregation", "progress", "keyvalue"] as const satisfies readonly ElementKind[];

export function isEditable(kind: ElementKind): boolean {
  return (EDITABLE_KINDS as readonly string[]).includes(kind);
}

export const DATASOURCE_KINDS = ["external", "internal", "static"] as const;
export type DatasourceKind = (typeof DATASOURCE_KINDS)[number];

export const FETCH_MODES = ["poll", "websocket"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

/**
 * How an external datasource keeps history (NULL = not tracked, the default).
 * `sample` appends one row per fetch, so an endpoint returning the current value becomes
 * graphable. `merge` upserts an array response's rows on `track_key`, so the stored series can
 * outgrow the window the API returns.
 */
export const TRACK_MODES = ["sample", "merge"] as const;
export type TrackMode = (typeof TRACK_MODES)[number];

export const COLUMN_TYPES = ["string", "number", "date", "boolean"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export type ProducerKind = "datasource" | "transformer";
export type ConsumerKind = "element" | "transformer";

export interface DashboardRow {
  id: string;
  name: string;
  grid_cols: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ElementRow {
  id: string;
  kind: ElementKind;
  title: string;
  config_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PlacementRow {
  element_id: string;
  dashboard_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface TaskItemRow {
  id: string;
  element_id: string;
  parent_id: string | null;
  title: string;
  done: number;
  sort_key: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface TableColumnRow {
  id: string;
  element_id: string;
  name: string;
  data_type: ColumnType;
  sort_key: string;
  deleted_at: number | null;
}

export interface TableRowRow {
  id: string;
  element_id: string;
  sort_key: string;
  created_at: number;
  deleted_at: number | null;
}

export interface TableCellRow {
  row_id: string;
  column_id: string;
  value_json: string | null;
  updated_at: number;
}

export interface DatasourceRow {
  id: string;
  name: string;
  kind: DatasourceKind;
  fetch_mode: FetchMode | null;
  url: string | null;
  method: string | null;
  poll_interval_ms: number | null;
  response_path: string | null;
  secrets_ciphertext: Uint8Array | null;
  track_mode: TrackMode | null;
  track_key: string | null;
  track_limit: number | null;
  source_element_id: string | null;
  static_value_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** One stored observation of a tracked datasource. Local-only; see `schema.ts` v3. */
export interface DatasourceSampleRow {
  datasource_id: string;
  sample_key: string;
  /** Ingest time, not a timestamp taken from the payload. */
  at: number;
  value_json: string;
}

export interface TransformerRow {
  id: string;
  name: string;
  current_version_id: string | null;
  timeout_ms: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface TransformerVersionRow {
  id: string;
  transformer_id: string;
  code: string;
  note: string | null;
  created_by_site: string;
  created_at: number;
}

export interface EdgeRow {
  id: string;
  consumer_kind: ConsumerKind;
  consumer_id: string;
  producer_kind: ProducerKind;
  producer_id: string;
  position: number;
  config_json: string;
  created_at: number;
  deleted_at: number | null;
}
