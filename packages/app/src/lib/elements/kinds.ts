import type { ElementKind } from "shared";
import type { Component } from "svelte";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import ListTreeIcon from "@lucide/svelte/icons/list-tree";
import Table2Icon from "@lucide/svelte/icons/table-2";
import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
import SigmaIcon from "@lucide/svelte/icons/sigma";

export interface KindMeta {
  kind: ElementKind;
  label: string;
  description: string;
  category: "editable" | "observable";
  icon: Component;
  defaultSize: { w: number; h: number };
}

export const KINDS: KindMeta[] = [
  {
    kind: "task",
    label: "Task",
    description: "A task with nested sub-tasks.",
    category: "editable",
    icon: ListTreeIcon,
    defaultSize: { w: 4, h: 4 },
  },
  {
    kind: "checklist",
    label: "Checklist",
    description: "Checkable items; items can hold sub-tasks.",
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
