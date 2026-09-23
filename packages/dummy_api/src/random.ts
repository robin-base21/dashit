/**
 * Deterministic pseudo-random values driven by wall-clock time. Nothing is stored: the value of a
 * metric at instant `t` is a pure function of its seed and `t`, so a series endpoint can hand back
 * a coherent history and consecutive polls slide that window instead of re-rolling noise.
 */

/** FNV-1a with a murmur3 final mix, so consecutive steps do not correlate. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Value noise sample in [0, 1) at an integer step. */
export function unit(seed: string, step: number): number {
  return hash32(`${seed}#${step}`) / 0x1_0000_0000;
}

/** Cosine-interpolated noise in [0, 1) — continuous, so plotted points form a curve. */
export function smooth(seed: string, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = unit(seed, i);
  const b = unit(seed, i + 1);
  const t = (1 - Math.cos(f * Math.PI)) / 2;
  return a * (1 - t) + b * t;
}

export interface WalkOptions {
  min: number;
  max: number;
  /** Time for one noise step; smaller means a twitchier metric. */
  periodMs: number;
  decimals: number;
}

/** Three octaves of `smooth` — the curve drifts without looking like a sine wave. */
export function walk(seed: string, tMs: number, { min, max, periodMs, decimals }: WalkOptions): number {
  const x = tMs / periodMs;
  const n =
    0.65 * smooth(seed, x) + 0.25 * smooth(`${seed}:o2`, x * 2.7) + 0.1 * smooth(`${seed}:o3`, x * 6.3);
  return round(min + n * (max - min), decimals);
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Floors an instant onto an interval grid, so a polled window only advances on a boundary. */
export function bucket(tMs: number, intervalMs: number): number {
  return Math.floor(tMs / intervalMs) * intervalMs;
}
