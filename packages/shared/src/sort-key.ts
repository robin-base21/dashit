import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Key that sorts after every key in `keys` (or the first key if empty). */
export function keyAfter(keys: readonly string[]): string {
  const max = keys.length ? keys.reduce((a, b) => (a > b ? a : b)) : null;
  return generateKeyBetween(max, null);
}

/** Key that sorts before every key in `keys`. */
export function keyBefore(keys: readonly string[]): string {
  const min = keys.length ? keys.reduce((a, b) => (a < b ? a : b)) : null;
  return generateKeyBetween(null, min);
}

export function keyBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b);
}

export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a, b, n);
}
