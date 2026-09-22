import type { LocalStore } from "../local-store.ts";
import * as dashboards from "./dashboards.ts";
import * as datasources from "./datasources.ts";
import * as edges from "./edges.ts";
import * as elementData from "./element-data.ts";
import * as elements from "./elements.ts";
import * as exp from "./export.ts";
import * as localMeta from "./local-meta.ts";
import * as tables from "./tables.ts";
import * as taskItems from "./task-items.ts";
import * as transformers from "./transformers.ts";

/**
 * Every repository function callable from the UI. The DB worker exposes exactly this map
 * over RPC, so transactions run where the database lives (ARCHITECTURE.md §6.2).
 */
export const commands = {
  ...dashboards,
  ...elements,
  ...edges,
  ...datasources,
  ...transformers,
  ...taskItems,
  ...tables,
  ...elementData,
  ...localMeta,
  exportData: exp.exportData,
  importData: exp.importData,
};

export type Commands = typeof commands;
export type CommandName = keyof Commands;

/** Parameters of a command without the leading LocalStore. */
export type CommandArgs<K extends CommandName> = Commands[K] extends (store: LocalStore, ...rest: infer R) => unknown
  ? R
  : never;

export type CommandResult<K extends CommandName> = Commands[K] extends (...args: never[]) => Promise<infer R>
  ? R
  : never;

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(commands, name) && typeof (commands as Record<string, unknown>)[name] === "function";
}
