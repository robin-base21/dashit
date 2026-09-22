import type { ConsumerKind, EdgeRow, ProducerKind } from "./types.ts";

export type NodeKind = "datasource" | "transformer" | "element";
export type NodeKey = `${NodeKind}:${string}`;

export function nodeKey(kind: NodeKind, id: string): NodeKey {
  return `${kind}:${id}`;
}

export type GraphEdge = Pick<
  EdgeRow,
  "consumer_kind" | "consumer_id" | "producer_kind" | "producer_id" | "position"
>;

export interface Graph {
  /** producer -> consumers */
  consumersOf: Map<NodeKey, NodeKey[]>;
  /** consumer -> producers, ordered by position */
  producersOf: Map<NodeKey, NodeKey[]>;
}

export function buildGraph(edges: Iterable<GraphEdge>): Graph {
  const consumersOf = new Map<NodeKey, NodeKey[]>();
  const producersOf = new Map<NodeKey, { key: NodeKey; position: number }[]>();

  for (const e of edges) {
    const p = nodeKey(e.producer_kind, e.producer_id);
    const c = nodeKey(e.consumer_kind, e.consumer_id);
    push(consumersOf, p, c);
    push(producersOf, c, { key: p, position: e.position });
  }

  const ordered = new Map<NodeKey, NodeKey[]>();
  for (const [c, ps] of producersOf) {
    ordered.set(
      c,
      ps.sort((a, b) => a.position - b.position).map((x) => x.key),
    );
  }
  return { consumersOf, producersOf: ordered };
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const arr = map.get(k);
  if (arr) arr.push(v);
  else map.set(k, [v]);
}

/**
 * Adding producer -> consumer creates a cycle iff the producer is reachable
 * downstream from the consumer (or they are the same node).
 */
export function wouldCreateCycle(
  graph: Graph,
  producer: { kind: ProducerKind; id: string },
  consumer: { kind: ConsumerKind; id: string },
): boolean {
  const target = nodeKey(producer.kind, producer.id);
  const start = nodeKey(consumer.kind, consumer.id);
  if (target === start) return true;

  const seen = new Set<NodeKey>([start]);
  const stack: NodeKey[] = [start];
  while (stack.length) {
    const n = stack.pop()!;
    for (const next of graph.consumersOf.get(n) ?? []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Datasources reachable upstream from the given visible elements.
 * Visible = placed, not hidden, not deleted (ARCHITECTURE.md §5.3).
 */
export function activeDatasources(graph: Graph, visibleElementIds: Iterable<string>): Set<string> {
  const active = new Set<string>();
  const seen = new Set<NodeKey>();
  const stack: NodeKey[] = [];
  for (const id of visibleElementIds) stack.push(nodeKey("element", id));

  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const p of graph.producersOf.get(n) ?? []) {
      if (p.startsWith("datasource:")) active.add(p.slice("datasource:".length));
      else stack.push(p);
    }
  }
  return active;
}

/** Topological order over all nodes in the graph (producers before consumers). */
export function topologicalOrder(graph: Graph): NodeKey[] {
  const indegree = new Map<NodeKey, number>();
  for (const [p, cs] of graph.consumersOf) {
    indegree.set(p, indegree.get(p) ?? 0);
    for (const c of cs) indegree.set(c, (indegree.get(c) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([k]) => k);
  const order: NodeKey[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const c of graph.consumersOf.get(n) ?? []) {
      const d = indegree.get(c)! - 1;
      indegree.set(c, d);
      if (d === 0) queue.push(c);
    }
  }
  return order;
}
