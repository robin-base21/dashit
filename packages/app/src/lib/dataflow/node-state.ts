/**
 * The state a dataflow node carries, and how an observable should present it. Kept out of
 * `engine.svelte.ts` (which uses runes, so `bun test` cannot import it) so the presentation rule
 * has somewhere to be tested.
 */

export type NodeStatus = "idle" | "running" | "ok" | "error" | "inactive" | "unbound";

export interface NodeState {
  status: NodeStatus;
  value: unknown;
  error: string | null;
  updatedAt: number;
  /** Bumps whenever `value` changes; downstream nodes re-run when an input version changes. */
  version: number;
  /** The value is the previous one and a fresher is being computed. Set by `presentState`. */
  stale?: boolean;
}

export const EMPTY: NodeState = { status: "idle", value: undefined, error: null, updatedAt: 0, version: 0 };

/**
 * How an observable element should see its producer.
 *
 * A transformer keeps its previous output while it re-runs, but reports `running` for the duration.
 * Passing that straight to a view means every view that gates on `ok` throws away a value it
 * already holds — a progress bar's `fraction` falls back to 0 and animates all the way down and
 * back on every upstream tick, and a chart drops its rows and re-animates. Present the value it
 * has and mark it stale; the node's own status stays honest for the transformer pages, which do
 * want to show that a run is in flight.
 *
 * A first run has nothing to show yet and stays `running`. An error is never masked by a stale
 * value: a transformer that has started failing must say so.
 */
export function presentState(state: NodeState): NodeState {
  if (state.status !== "running" || state.value === undefined) return state;
  return { ...state, status: "ok", stale: true };
}
