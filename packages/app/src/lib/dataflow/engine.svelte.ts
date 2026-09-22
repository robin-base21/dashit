import {
  activeDatasources,
  buildGraph,
  nodeKey,
  topologicalOrder,
  type Dataset,
  type DatasourceRow,
  type Graph,
  type NodeKey,
} from "shared";
import { createContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { Db } from "$lib/db/client.svelte";
import { Sandbox, type JsonValue } from "$lib/sandbox/sandbox";

export type NodeStatus = "idle" | "running" | "ok" | "error" | "inactive" | "unbound";

export interface NodeState {
  status: NodeStatus;
  value: unknown;
  error: string | null;
  updatedAt: number;
  /** Bumps whenever `value` changes; downstream nodes re-run when an input version changes. */
  version: number;
}

const EMPTY: NodeState = { status: "idle", value: undefined, error: null, updatedAt: 0, version: 0 };

// Tables whose changes require re-reading internal datasources.
const EDITABLE_TABLES = ["task_items", "table_columns", "table_rows", "table_cells", "elements"];
const GRAPH_TABLES = ["datasources", "edges", "transformers", "transformer_versions", "placements", "elements"];

/**
 * Async DAG scheduler (ARCHITECTURE.md §5.2). Datasources are read from the DB, transformers run
 * in the sandbox, observable elements receive their producers' values. Whole-graph passes are
 * cheap because only nodes whose input versions changed do real work.
 */
export class Dataflow {
  readonly nodes = new SvelteMap<NodeKey, NodeState>();
  activeDatasourceIds = $state.raw<Set<string>>(new Set());
  /** Bumps when edges/nodes are reloaded so graph-shape reads (producersOf) are reactive. */
  graphVersion = $state(0);

  #db: Db;
  #sandbox = new Sandbox();
  #graph: Graph = buildGraph([]);
  #datasources = new Map<string, DatasourceRow>();
  #codeByTransformer = new Map<string, { code: string; timeoutMs: number }>();
  #lastInputs = new Map<NodeKey, string>();
  #generation = 0;
  #running = false;
  #queued: { graph: boolean; data: boolean } | null = null;
  #stop: (() => void)[] = [];

  constructor(db: Db) {
    this.#db = db;
  }

  start(): void {
    this.#stop.push(this.#db.onChange(GRAPH_TABLES, () => this.invalidate(true)));
    this.#stop.push(this.#db.onChange(EDITABLE_TABLES, () => this.invalidate(false)));
    void this.invalidate(true);
  }

  stop(): void {
    for (const s of this.#stop) s();
    this.#stop = [];
    this.#sandbox.destroy();
  }

  get(key: NodeKey): NodeState {
    return this.nodes.get(key) ?? EMPTY;
  }

  /** Producers feeding an element, in position order. */
  producersOf(elementId: string): NodeKey[] {
    void this.graphVersion;
    return this.#graph.producersOf.get(nodeKey("element", elementId)) ?? [];
  }

  /** The dataset an observable element should render: its first producer's value. */
  datasetOf(elementId: string): { state: NodeState; producer: NodeKey | null } {
    const [producer] = this.producersOf(elementId);
    if (!producer) return { state: { ...EMPTY, status: "unbound" }, producer: null };
    return { state: this.get(producer), producer };
  }

  /** Re-run the graph. `graphChanged` reloads nodes/edges; otherwise only data is re-read. */
  async invalidate(graphChanged: boolean): Promise<void> {
    if (this.#running) {
      this.#queued = { graph: (this.#queued?.graph ?? false) || graphChanged, data: true };
      return;
    }
    this.#running = true;
    const gen = ++this.#generation;
    try {
      if (graphChanged) await this.#loadGraph();
      await this.#evaluate(gen);
    } finally {
      this.#running = false;
      const q = this.#queued;
      this.#queued = null;
      if (q) void this.invalidate(q.graph);
    }
  }

  async #loadGraph(): Promise<void> {
    const [edges, datasources, transformers, visible] = await Promise.all([
      this.#db.call("listEdges"),
      this.#db.call("listDatasources"),
      this.#db.call("listTransformers"),
      this.#db.call("listVisibleElementIds"),
    ]);
    this.#graph = buildGraph(edges);
    this.#datasources = new Map(datasources.map((d) => [d.id, d]));
    this.activeDatasourceIds = activeDatasources(this.#graph, visible);
    this.graphVersion++;

    this.#codeByTransformer.clear();
    await Promise.all(
      transformers.map(async (t) => {
        if (!t.current_version_id) return;
        const versions = await this.#db.call("listTransformerVersions", t.id);
        const v = versions.find((x) => x.id === t.current_version_id);
        if (v) this.#codeByTransformer.set(t.id, { code: v.code, timeoutMs: t.timeout_ms });
      }),
    );

    // Drop state for nodes that no longer exist.
    const live = new Set<NodeKey>();
    for (const d of datasources) live.add(nodeKey("datasource", d.id));
    for (const t of transformers) live.add(nodeKey("transformer", t.id));
    for (const e of edges) live.add(nodeKey(e.consumer_kind, e.consumer_id));
    for (const k of [...this.nodes.keys()]) if (!live.has(k)) this.nodes.delete(k);
  }

  async #evaluate(gen: number): Promise<void> {
    // Datasources not in any edge still get evaluated so the datasources page can preview them.
    const order = new Set<NodeKey>(topologicalOrder(this.#graph));
    for (const id of this.#datasources.keys()) order.add(nodeKey("datasource", id));

    for (const key of order) {
      if (this.#queued || gen !== this.#generation) return; // a newer pass is pending; stop early
      const [kind, id] = key.split(":") as ["datasource" | "transformer" | "element", string];
      switch (kind) {
        case "datasource":
          await this.#evalDatasource(id, key);
          break;
        case "transformer":
          await this.#evalTransformer(id, key);
          break;
        case "element":
          this.#evalElement(key);
          break;
      }
    }
  }

  #set(key: NodeKey, patch: Partial<NodeState>, valueChanged: boolean): void {
    const prev = this.get(key);
    this.nodes.set(key, {
      ...prev,
      ...patch,
      updatedAt: Date.now(),
      version: valueChanged ? prev.version + 1 : prev.version,
    });
  }

  #inputSignature(key: NodeKey): string {
    return (this.#graph.producersOf.get(key) ?? []).map((p) => `${p}@${this.get(p).version}:${this.get(p).status}`).join("|");
  }

  async #evalDatasource(id: string, key: NodeKey): Promise<void> {
    const ds = this.#datasources.get(id);
    if (!ds) return;
    try {
      let value: unknown;
      switch (ds.kind) {
        case "static":
          value = ds.static_value_json === null ? null : JSON.parse(ds.static_value_json);
          break;
        case "internal":
          value = ds.source_element_id ? await this.#db.call("readElementData", ds.source_element_id) : [];
          break;
        case "external":
          // Phase 1.5: DatasourceRuntime feeds external values; until then they are inactive.
          this.#set(key, { status: "inactive", value: undefined, error: null }, false);
          return;
      }
      const changed = JSON.stringify(value) !== JSON.stringify(this.get(key).value);
      this.#set(key, { status: "ok", value, error: null }, changed);
    } catch (e) {
      this.#set(key, { status: "error", error: e instanceof Error ? e.message : String(e) }, true);
    }
  }

  async #evalTransformer(id: string, key: NodeKey): Promise<void> {
    const sig = this.#inputSignature(key);
    if (sig === this.#lastInputs.get(key) && this.get(key).status !== "idle") return;
    this.#lastInputs.set(key, sig);

    const producers = this.#graph.producersOf.get(key) ?? [];
    const upstreamError = producers.find((p) => this.get(p).status === "error");
    if (upstreamError) {
      this.#set(key, { status: "error", error: `upstream error in ${upstreamError}` }, true);
      return;
    }
    const code = this.#codeByTransformer.get(id);
    if (!code) {
      this.#set(key, { status: "error", error: "transformer has no code" }, true);
      return;
    }
    this.#set(key, { status: "running" }, false);
    const inputs = producers.map((p) => (this.get(p).value ?? null) as JsonValue);
    const result = await this.#sandbox.run(code.code, inputs, code.timeoutMs);
    if (result.ok) this.#set(key, { status: "ok", value: result.output, error: null }, true);
    else this.#set(key, { status: "error", error: `${result.error.name}: ${result.error.message}` }, true);
  }

  #evalElement(key: NodeKey): void {
    const sig = this.#inputSignature(key);
    const changed = sig !== this.#lastInputs.get(key);
    this.#lastInputs.set(key, sig);
    const [first] = this.#graph.producersOf.get(key) ?? [];
    if (!first) {
      this.#set(key, { status: "unbound", value: undefined, error: null }, changed);
      return;
    }
    const src = this.get(first);
    this.#set(key, { status: src.status, value: src.value, error: src.error }, changed);
  }
}

export type { Dataset };

export const [getDataflow, setDataflow] = createContext<Dataflow>();
