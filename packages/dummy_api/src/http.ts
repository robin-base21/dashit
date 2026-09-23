/** Request plumbing: CORS (the app fetches these URLs from the browser) and query parsing. */

export type Handler = (req: Request, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
export type RouteTable = Record<string, Handler | Record<string, Handler>>;

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * DashIt polls from the main thread, so every response needs CORS and every custom header
 * (`Authorization`, `X-API-Key`) triggers a preflight. `Access-Control-Allow-Headers: *` does not
 * cover `Authorization` per the Fetch spec, so the requested headers are reflected instead.
 */
export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Access-Control-Expose-Headers": "*",
    "Vary": "Origin",
  };
}

function preflight(req: Request, methods: string[]): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(", "),
      "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "*",
      "Access-Control-Max-Age": "600",
    },
  });
}

/** Expands a route table into Bun's `routes`, adding CORS headers and an OPTIONS handler. */
export function withCors(table: RouteTable): Record<string, unknown> {
  const out: Record<string, Record<string, Handler>> = {};
  for (const [path, route] of Object.entries(table)) {
    const methods: Record<string, Handler> =
      typeof route === "function" ? Object.fromEntries(ALL_METHODS.map((m) => [m, route])) : route;
    const names = Object.keys(methods);
    const wrapped: Record<string, Handler> = {
      OPTIONS: (req) => preflight(req, names),
    };
    for (const [method, handler] of Object.entries(methods)) {
      wrapped[method] = async (req, server) => {
        const res = await handler(req, server);
        // A websocket upgrade answers the request itself.
        if (!res) return undefined;
        for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
        return res;
      };
    }
    out[path] = wrapped;
  }
  return out;
}

export function json(req: Request, value: unknown, init?: ResponseInit): Response {
  return Response.json(value, { ...init, headers: { ...init?.headers, ...corsHeaders(req) } });
}

export function fail(req: Request, status: number, error: string, extra?: Record<string, unknown>): Response {
  return json(req, { error, status, ...extra }, { status });
}

/** A positive integer query param, clamped; falls back on anything unparseable. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function floatParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A comma-separated list filtered to `allowed`; empty selections fall back. */
export function listParam(url: URL, name: string, fallback: string[], allowed: string[]): string[] {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));
  return picked.length > 0 ? picked : fallback;
}
