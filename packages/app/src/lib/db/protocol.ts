import type { CommandName } from "shared";
import type { Vfs } from "./open";

export interface InitResult {
  vfs: Vfs;
  siteId: string;
  schemaVersion: number;
  dashboardId: string;
}

export type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "call"; name: CommandName; args: unknown[] }
  | { id: number; type: "close" };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } }
  | { id?: undefined; type: "changed"; tables: string[] };
