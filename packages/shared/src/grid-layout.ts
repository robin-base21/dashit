export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function clampToColumns(r: Rect, cols: number): Rect {
  const w = Math.max(1, Math.min(r.w, cols));
  const x = Math.max(0, Math.min(r.x, cols - w));
  return { ...r, x, w, y: Math.max(0, r.y), h: Math.max(1, r.h) };
}

/**
 * Places `moving` at its requested position, shoving overlapping items down (recursively),
 * then compacts everything upward. `moving` keeps its exact position; other items only move
 * vertically. Returns a new array sorted by (y, x).
 */
export function resolveLayout(items: readonly Rect[], moving: Rect, cols: number): Rect[] {
  const pinned = clampToColumns(moving, cols);
  const others = items.filter((r) => r.id !== pinned.id).map((r) => ({ ...r }));

  // Shove down anything overlapping the pinned item, cascading.
  const queue: Rect[] = [pinned];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const o of others) {
      if (o === cur) continue;
      if (overlaps(cur, o)) {
        o.y = cur.y + cur.h;
        queue.push(o);
      }
    }
  }

  return compact([pinned, ...others], pinned.id);
}

/** Moves every item (except `pinnedId`) as far up as it can go without overlapping. */
export function compact(items: readonly Rect[], pinnedId?: string): Rect[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Rect[] = [];
  for (const item of sorted) {
    const r = { ...item };
    if (r.id !== pinnedId) {
      while (r.y > 0) {
        const up = { ...r, y: r.y - 1 };
        if (placed.some((p) => overlaps(up, p))) break;
        r.y = up.y;
      }
    }
    placed.push(r);
  }
  return placed.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** First position (scanning rows top to bottom, then columns) where a w×h item fits. */
export function findFreeSpot(items: readonly Rect[], w: number, h: number, cols: number): { x: number; y: number } {
  const width = Math.min(w, cols);
  const maxY = items.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + width <= cols; x++) {
      const probe = { id: "", x, y, w: width, h };
      if (!items.some((r) => overlaps(probe, r))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

/** Items whose position changed between two layouts. */
export function diffLayout(before: readonly Rect[], after: readonly Rect[]): Rect[] {
  const prev = new Map(before.map((r) => [r.id, r]));
  return after.filter((r) => {
    const p = prev.get(r.id);
    return !p || p.x !== r.x || p.y !== r.y || p.w !== r.w || p.h !== r.h;
  });
}
