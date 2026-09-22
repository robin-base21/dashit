/**
 * Extracts a sub-value using either a JSON Pointer ("/data/items/0") or a dot path
 * ("data.items[0]" / "data.items.0"). Empty path returns the input. Missing segments yield undefined.
 */
export function extractPath(value: unknown, path: string | null | undefined): unknown {
  if (!path || path.trim() === "" || path === "/") return value;
  const segments = path.startsWith("/")
    ? path.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    : path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter((s) => s !== "");
  let cur: unknown = value;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}
