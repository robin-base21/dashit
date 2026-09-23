import { describe, expect, test } from "bun:test";
import { chunkRows, MAX_ENVELOPE_BYTES } from "../src/sync.ts";

describe("chunkRows", () => {
  const size = () => 100;

  test("an empty changeset produces no envelopes", () => {
    expect(chunkRows([], size)).toEqual([]);
  });

  test("everything fits in one envelope when it is small", () => {
    expect(chunkRows([1, 2, 3], size)).toEqual([[1, 2, 3]]);
  });

  test("splits on the size cap, keeping order", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(chunkRows(rows, size, 250)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  test("a single oversized row gets its own envelope rather than being dropped", () => {
    // Losing it silently would leave a hole in the stream; the relay rejecting it is a clearer
    // failure than data that never arrives.
    const rows = [1, 2, 3];
    const sizes = new Map([[2, 5_000]]);
    expect(chunkRows(rows, (r) => sizes.get(r) ?? 100, 1_000)).toEqual([[1], [2], [3]]);
  });

  test("defaults to the documented 1 MiB cap", () => {
    const rows = Array.from({ length: 3 }, (_, i) => i);
    const half = Math.floor(MAX_ENVELOPE_BYTES * 0.6);
    expect(chunkRows(rows, () => half)).toEqual([[0], [1], [2]]);
  });
});
