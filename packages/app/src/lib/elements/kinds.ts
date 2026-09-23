import type { ElementKind } from "shared";
import type { Component } from "svelte";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import Table2Icon from "@lucide/svelte/icons/table-2";
import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
import CircleGaugeIcon from "@lucide/svelte/icons/circle-gauge";
import TablePropertiesIcon from "@lucide/svelte/icons/table-properties";
import SigmaIcon from "@lucide/svelte/icons/sigma";

export type ElementCategory = "editable" | "observable";

export interface KindMeta {
  kind: ElementKind;
  label: string;
  description: string;
  category: ElementCategory;
  icon: Component;
  defaultSize: { w: number; h: number };
}

export const KINDS: KindMeta[] = [
  {
    kind: "task",
    label: "Task list",
    description: "Checkable items with nested sub-tasks.",
    category: "editable",
    icon: ListChecksIcon,
    defaultSize: { w: 4, h: 4 },
  },
  {
    kind: "table",
    label: "Table",
    description: "Rows and typed columns you define.",
    category: "editable",
    icon: Table2Icon,
    defaultSize: { w: 6, h: 4 },
  },
  {
    kind: "aggregation",
    label: "Aggregation",
    description: "A single computed value: count, sum, average, …",
    category: "observable",
    icon: SigmaIcon,
    defaultSize: { w: 3, h: 2 },
  },
  {
    kind: "progress",
    label: "Progress",
    description: "A bar showing how far a value has got, as a percentage or n of m.",
    category: "observable",
    icon: CircleGaugeIcon,
    defaultSize: { w: 3, h: 2 },
  },
  {
    kind: "keyvalue",
    label: "Key/value list",
    description: "Labelled readings, formatted by type and unit.",
    category: "observable",
    icon: TablePropertiesIcon,
    defaultSize: { w: 3, h: 4 },
  },
  {
    kind: "chart",
    label: "Chart",
    description: "Bar, line, area, pie, radar or radial chart.",
    category: "observable",
    icon: ChartColumnIcon,
    defaultSize: { w: 6, h: 4 },
  },
];

export const KIND_META: Record<ElementKind, KindMeta> = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<
  ElementKind,
  KindMeta
>;

export interface CategoryMeta {
  category: ElementCategory;
  label: string;
  /** One line explaining where the element's content comes from. */
  hint: string;
  kinds: KindMeta[];
}

/**
 * The two halves of the element model. Editables hold content the user types; observables render
 * something derived from a datasource and cannot be edited in place. Every surface that lists
 * elements groups or marks them by this, so the distinction is visible before you click.
 */
export const CATEGORIES: CategoryMeta[] = [
  {
    category: "editable",
    label: "Editable",
    hint: "You fill these in.",
    kinds: KINDS.filter((k) => k.category === "editable"),
  },
  {
    category: "observable",
    label: "Observable",
    hint: "Computed from bound data.",
    kinds: KINDS.filter((k) => k.category === "observable"),
  },
];

export const CATEGORY_META: Record<ElementCategory, CategoryMeta> = Object.fromEntries(
  CATEGORIES.map((c) => [c.category, c]),
) as Record<ElementCategory, CategoryMeta>;

export function categoryOf(kind: ElementKind): ElementCategory {
  return KIND_META[kind].category;
}
