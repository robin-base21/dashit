import { describe, expect, test } from "bun:test";
import { uuidv7 } from "../src/ids.ts";
import { keyAfter, keyBefore, keyBetween } from "../src/sort-key.ts";

describe("uuidv7", () => {
  test("is well-formed and time-ordered", () => {
    const a = uuidv7(1_000_000);
    const b = uuidv7(2_000_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  test("is monotonic within one millisecond", () => {
    const ids = Array.from({ length: 500 }, () => uuidv7(5_000_000));
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1]! < ids[i]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sort keys", () => {
  test("interleave without losing precision", () => {
    let lo = keyAfter([]);
    let hi = keyAfter([lo]);
    expect(lo < hi).toBe(true);
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      lo = mid;
    }
    expect(keyBefore([lo, hi]) < lo).toBe(true);
  });
});
