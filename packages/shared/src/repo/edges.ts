import { buildGraph, wouldCreateCycle } from "../graph.ts";
import { uuidv7 } from "../ids.ts";
import type { LocalStore } from "../local-store.ts";
import type { ConsumerKind, EdgeRow, ProducerKind } from "../types.ts";

export class CycleError extends Error {
  constructor() {
    super("edge would create a cycle in the dataflow graph");
    this.name = "CycleError";
  }
}

export async function listEdges(store: LocalStore): Promise<EdgeRow[]> {
  return store.query<EdgeRow>(`SELECT * FROM edges WHERE deleted_at IS NULL ORDER BY position, created_at`);
}

export interface AddEdgeInput {
  producer_kind: ProducerKind;
  producer_id: string;
  consumer_kind: ConsumerKind;
  consumer_id: string;
  position?: number;
  config?: Record<string, unknown>;
}

/** Inserts an edge after checking the live graph for cycles. */
export async function addEdge(store: LocalStore, input: AddEdgeInput, now: number = Date.now()): Promise<string> {
  return store.transaction(async (tx) => {
    const graph = buildGraph(await listEdges(tx));
    if (
      wouldCreateCycle(
        graph,
        { kind: input.producer_kind, id: input.producer_id },
        { kind: input.consumer_kind, id: input.consumer_id },
      )
    ) {
      throw new CycleError();
    }
    const id = uuidv7(now);
    await tx.exec(
      `INSERT INTO edges (id, consumer_kind, consumer_id, producer_kind, producer_id, position, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.consumer_kind,
        input.consumer_id,
        input.producer_kind,
        input.producer_id,
        input.position ?? 0,
        JSON.stringify(input.config ?? {}),
        now,
      ],
    );
    return id;
  });
}

export async function setEdgePosition(store: LocalStore, id: string, position: number): Promise<void> {
  await store.exec(`UPDATE edges SET position = ? WHERE id = ? AND deleted_at IS NULL`, [position, id]);
}

export async function removeEdge(store: LocalStore, id: string, now: number = Date.now()): Promise<void> {
  await store.exec(`UPDATE edges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, id]);
}

/** Tombstones every live edge touching a node in either role. */
export async function removeEdgesForNode(
  store: LocalStore,
  kind: ProducerKind | ConsumerKind,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await store.exec(
    `UPDATE edges SET deleted_at = ? WHERE deleted_at IS NULL AND (
       (producer_kind = ? AND producer_id = ?) OR (consumer_kind = ? AND consumer_id = ?))`,
    [now, kind, id, kind, id],
  );
}
