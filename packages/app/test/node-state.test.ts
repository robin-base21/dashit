import { describe, expect, test } from "bun:test";
import { EMPTY, presentState, type NodeState } from "../src/lib/dataflow/node-state.ts";

const node = (over: Partial<NodeState> = {}): NodeState => ({ ...EMPTY, ...over });

describe("presentState", () => {
  test("a re-running node shows the value it still holds", () => {
    const out = presentState(node({ status: "running", value: [{ n: 1 }], version: 3 }));
    expect(out.status).toBe("ok");
    expect(out.stale).toBe(true);
    // The value and version are untouched, so nothing downstream sees a change.
    expect(out.value).toEqual([{ n: 1 }]);
    expect(out.version).toBe(3);
  });

  test("a first run has nothing to show and stays running", () => {
    const out = presentState(node({ status: "running", value: undefined }));
    expect(out.status).toBe("running");
    expect(out.stale).toBeUndefined();
  });

  test("a value of null is a value, not an absent one", () => {
    // `null` is a legitimate transformer output; only `undefined` means "never produced".
    expect(presentState(node({ status: "running", value: null })).status).toBe("ok");
  });

  test("an error is never masked by a stale value", () => {
    const out = presentState(node({ status: "error", value: [{ n: 1 }], error: "boom" }));
    expect(out.status).toBe("error");
    expect(out.error).toBe("boom");
    expect(out.stale).toBeUndefined();
  });

  test("every other status passes through untouched", () => {
    for (const status of ["idle", "ok", "inactive", "unbound"] as const) {
      const input = node({ status, value: [{ n: 1 }] });
      expect(presentState(input), `status "${status}" was rewritten`).toBe(input);
    }
  });

  test("a fresh ok value is not marked stale", () => {
    expect(presentState(node({ status: "ok", value: 1 })).stale).toBeUndefined();
  });
});
