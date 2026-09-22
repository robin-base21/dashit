import { describe, expect, test } from "bun:test";
import { compact, diffLayout, findFreeSpot, resolveLayout, type Rect } from "../src/grid-layout.ts";

const r = (id: string, x: number, y: number, w: number, h: number): Rect => ({ id, x, y, w, h });

describe("resolveLayout", () => {
  test("shoves overlapping items down and keeps the moving item pinned", () => {
    const items = [r("a", 0, 0, 4, 2), r("b", 0, 2, 4, 2)];
    const out = resolveLayout(items, r("c", 0, 0, 4, 1), 12);
    const by = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(by.c).toMatchObject({ x: 0, y: 0 });
    expect(by.a).toMatchObject({ y: 1 });
    expect(by.b).toMatchObject({ y: 3 });
  });

  test("compacts upward into gaps after a move", () => {
    const items = [r("a", 0, 0, 4, 2), r("b", 0, 2, 4, 2), r("c", 0, 4, 4, 1)];
    // move a to the far right; b and c should rise to the top
    const out = resolveLayout(items, r("a", 8, 0, 4, 2), 12);
    const by = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ x: 8, y: 0 });
    expect(by.b).toMatchObject({ x: 0, y: 0 });
    expect(by.c).toMatchObject({ x: 0, y: 2 });
  });

  test("clamps to the column count", () => {
    const out = resolveLayout([], r("a", 11, 0, 4, 1), 12);
    expect(out[0]).toMatchObject({ x: 8, w: 4 });
  });

  test("does not overlap after resolution", () => {
    const items = [r("a", 0, 0, 6, 2), r("b", 6, 0, 6, 2), r("c", 0, 2, 12, 1), r("d", 3, 3, 3, 3)];
    const out = resolveLayout(items, r("d", 2, 0, 5, 2), 12);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const disjoint = a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
        expect(disjoint, `${a.id} overlaps ${b.id}`).toBe(true);
      }
  });
});

describe("helpers", () => {
  test("compact removes vertical gaps", () => {
    const out = compact([r("a", 0, 3, 2, 1), r("b", 2, 5, 2, 1)]);
    expect(out.map((x) => x.y)).toEqual([0, 0]);
  });

  test("findFreeSpot picks the first fit, then the bottom", () => {
    const items = [r("a", 0, 0, 8, 2), r("b", 8, 0, 4, 1)];
    expect(findFreeSpot(items, 4, 1, 12)).toEqual({ x: 8, y: 1 });
    expect(findFreeSpot(items, 12, 1, 12)).toEqual({ x: 0, y: 2 });
  });

  test("diffLayout reports only moved items", () => {
    const before = [r("a", 0, 0, 1, 1), r("b", 1, 0, 1, 1)];
    const after = [r("a", 0, 0, 1, 1), r("b", 1, 2, 1, 1)];
    expect(diffLayout(before, after).map((x) => x.id)).toEqual(["b"]);
  });
});
