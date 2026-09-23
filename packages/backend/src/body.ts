import type { Context } from "hono";

/**
 * Request body as untrusted, possibly-absent fields. A malformed body is an empty object rather
 * than a throw, so every route validates the shape it needs instead of relying on a parse failure.
 */
export async function readBody<T extends object>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}
