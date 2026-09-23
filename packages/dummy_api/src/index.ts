import { ENDPOINTS } from "./catalog.ts";
import {
  buildSales,
  buildSeries,
  buildSnapshot,
  DEFAULT_METRICS,
  DEFAULT_SALES_GROUP,
  METRIC_NAMES,
  metricAt,
  resolveSalesGroup,
  SALES_GROUPS,
  toCsv,
} from "./data.ts";
import { corsHeaders, fail, floatParam, intParam, json, listParam, withCors, type RouteTable } from "./http.ts";
import { indexPage } from "./index-page.ts";

const PORT = Number(process.env.PORT ?? 3100);
const TOKEN = process.env.DUMMY_API_TOKEN ?? "dev-token";
const API_KEY = process.env.DUMMY_API_KEY ?? "dev-key";

const SERIES_DEFAULTS = { points: 30, intervalMs: 60_000 };

interface SocketData {
  intervalMs: number;
  metrics: string[];
  timer: ReturnType<typeof setInterval> | null;
}

/** Series options from the query string, clamped so a typo cannot ask for a million points. */
function seriesQuery(url: URL) {
  return {
    points: intParam(url, "points", SERIES_DEFAULTS.points, 1, 500),
    intervalMs: intParam(url, "interval", SERIES_DEFAULTS.intervalMs, 1_000, 86_400_000),
    metrics: listParam(url, "metrics", DEFAULT_METRICS, METRIC_NAMES),
    now: Date.now(),
  };
}

function salesQuery(url: URL): string {
  return resolveSalesGroup(url.searchParams.get("group"));
}

function bearerOk(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === TOKEN;
}

function tick(metrics: string[], now = Date.now()) {
  const values: Record<string, number> = {};
  for (const name of metrics) values[name] = metricAt(name, now);
  return { t: new Date(now).toISOString(), ...values };
}

const routes: RouteTable = {
  "/": {
    GET: (req) => {
      const url = new URL(req.url);
      if ((req.headers.get("accept") ?? "").includes("text/html")) {
        return new Response(indexPage(url.origin, TOKEN, API_KEY), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(req) },
        });
      }
      return json(req, { name: "dummy_api", origin: url.origin, auth: { bearer: TOKEN, api_key: API_KEY }, endpoints: ENDPOINTS });
    },
  },

  "/health": { GET: (req) => json(req, { ok: true, now: new Date().toISOString() }) },

  "/series": { GET: (req) => json(req, buildSeries(seriesQuery(new URL(req.url)))) },

  "/sales": {
    GET: (req) => {
      const url = new URL(req.url);
      return json(req, buildSales(salesQuery(url), Date.now()));
    },
  },

  "/metrics": { GET: (req) => json(req, buildSnapshot(Date.now())) },

  "/nested": {
    GET: (req) => {
      const options = seriesQuery(new URL(req.url));
      return json(req, {
        status: "ok",
        meta: { generated_at: new Date(options.now).toISOString(), count: options.points, metrics: options.metrics },
        data: { series: buildSeries(options) },
      });
    },
  },

  "/csv": {
    GET: (req) => {
      const group = salesQuery(new URL(req.url));
      return new Response(toCsv(buildSales(group, Date.now())), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `inline; filename="sales-by-${group}.csv"`,
          ...corsHeaders(req),
        },
      });
    },
  },

  "/flaky": {
    GET: (req) => {
      const url = new URL(req.url);
      const rate = floatParam(url, "rate", 0.3, 0, 1);
      const status = intParam(url, "status", 500, 400, 599);
      if (Math.random() < rate) return fail(req, status, "the dice said no", { rate });
      return json(req, { ok: true, rate, ...buildSnapshot(Date.now()) });
    },
  },

  "/slow": {
    GET: async (req) => {
      const ms = intParam(new URL(req.url), "ms", 1_500, 0, 30_000);
      await Bun.sleep(ms);
      return json(req, { ok: true, delayed_ms: ms, ...buildSnapshot(Date.now()) });
    },
  },

  "/secure/metrics": {
    GET: (req) =>
      bearerOk(req)
        ? json(req, { authorized_as: "bearer", ...buildSnapshot(Date.now()) })
        : fail(req, 401, "missing or wrong bearer token", { expected: "Authorization: Bearer <token>" }),
  },

  "/secure/series": {
    GET: (req) =>
      req.headers.get("x-api-key") === API_KEY
        ? json(req, buildSeries(seriesQuery(new URL(req.url))))
        : fail(req, 401, "missing or wrong api key", { expected: "X-API-Key: <key>" }),
  },

  "/query": {
    POST: async (req) => {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch (e) {
        return fail(req, 400, `body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      const group = typeof body.group === "string" && body.group in SALES_GROUPS ? body.group : null;
      const now = Date.now();
      if (group) return json(req, { ok: true, params: { group }, data: buildSales(group, now) });

      const metrics = Array.isArray(body.metrics)
        ? body.metrics.filter((m): m is string => typeof m === "string" && METRIC_NAMES.includes(m))
        : [];
      const options = {
        points: clamp(body.points, 30, 1, 500),
        intervalMs: clamp(body.interval, 60_000, 1_000, 86_400_000),
        metrics: metrics.length > 0 ? metrics : DEFAULT_METRICS,
        now,
      };
      return json(req, { ok: true, params: options, data: buildSeries(options) });
    },
  },

  "/echo": async (req) => {
    const url = new URL(req.url);
    const text = await req.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return json(req, {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(req.headers),
      body: text === "" ? null : text,
      parsed_body: parsed,
      received_at: new Date().toISOString(),
    });
  },

  "/sse": {
    GET: (req) => {
      const url = new URL(req.url);
      const intervalMs = intParam(url, "interval", 1_000, 200, 60_000);
      const metrics = listParam(url, "metrics", DEFAULT_METRICS, METRIC_NAMES);
      let timer: ReturnType<typeof setInterval>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = () => {
            const payload = JSON.stringify(tick(metrics));
            try {
              controller.enqueue(encoder.encode(`event: tick\ndata: ${payload}\n\n`));
            } catch {
              clearInterval(timer);
            }
          };
          controller.enqueue(encoder.encode(`retry: 2000\n\n`));
          send();
          timer = setInterval(send, intervalMs);
          req.signal.addEventListener("abort", () => {
            clearInterval(timer);
            try {
              controller.close();
            } catch {
              // already closed by the disconnect
            }
          });
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...corsHeaders(req),
        },
      });
    },
  },

  "/ws": {
    GET: (req, server) => {
      const url = new URL(req.url);
      const data: SocketData = {
        intervalMs: intParam(url, "interval", 1_000, 200, 60_000),
        metrics: listParam(url, "metrics", DEFAULT_METRICS, METRIC_NAMES),
        timer: null,
      };
      if (server.upgrade(req, { data })) return undefined;
      return fail(req, 426, "this endpoint expects a websocket upgrade");
    },
  },
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const server = Bun.serve({
  port: PORT,
  routes: withCors(routes) as never,
  fetch: (req) => fail(req, 404, "no such endpoint", { index: new URL(req.url).origin }),
  websocket: {
    open(ws: Bun.ServerWebSocket<SocketData>) {
      const push = () => ws.send(JSON.stringify({ type: "tick", ...tick(ws.data.metrics) }));
      push();
      ws.data.timer = setInterval(push, ws.data.intervalMs);
    },
    message(ws: Bun.ServerWebSocket<SocketData>, message) {
      // `{"type":"subscribe","metrics":[...],"interval":2000}` re-arms the ticker; anything else echoes.
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(String(message)) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (parsed?.type !== "subscribe") {
        ws.send(JSON.stringify({ type: "echo", received: String(message) }));
        return;
      }
      if (Array.isArray(parsed.metrics)) {
        const picked = parsed.metrics.filter((m): m is string => typeof m === "string" && METRIC_NAMES.includes(m));
        if (picked.length > 0) ws.data.metrics = picked;
      }
      const interval = Number(parsed.interval);
      if (Number.isFinite(interval)) ws.data.intervalMs = Math.min(60_000, Math.max(200, Math.floor(interval)));
      if (ws.data.timer) clearInterval(ws.data.timer);
      const push = () => ws.send(JSON.stringify({ type: "tick", ...tick(ws.data.metrics) }));
      ws.data.timer = setInterval(push, ws.data.intervalMs);
      ws.send(JSON.stringify({ type: "subscribed", metrics: ws.data.metrics, interval: ws.data.intervalMs }));
    },
    close(ws: Bun.ServerWebSocket<SocketData>) {
      if (ws.data.timer) clearInterval(ws.data.timer);
    },
  },
});

console.log(`dummy_api listening on ${server.url}`);
console.log(`  bearer token: ${TOKEN}`);
console.log(`  api key:      ${API_KEY}`);
