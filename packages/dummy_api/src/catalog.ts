/** The endpoint list, shared by `GET /` (JSON) and the HTML index. */

export interface Endpoint {
  methods: string[];
  path: string;
  summary: string;
  /** What to put in a datasource's `response_path`, when the payload is nested. */
  response_path?: string;
  auth?: string;
  shape: "rows" | "object" | "text" | "stream";
}

export const ENDPOINTS: Endpoint[] = [
  {
    methods: ["GET"],
    path: "/series?points=30&interval=60000&metrics=cpu,memory,requests",
    summary: "Time series rows — x axis `label`, one numeric column per metric. Slides on each poll.",
    shape: "rows",
  },
  {
    methods: ["GET"],
    path: "/sales?group=region",
    summary: "Categorical rows (group=region|quarter|channel) with revenue, units and orders.",
    shape: "rows",
  },
  {
    methods: ["GET"],
    path: "/metrics",
    summary: "One flat object — cpu, memory, disk, latency, error rate, uptime.",
    shape: "object",
  },
  {
    methods: ["GET"],
    path: "/nested?points=20",
    summary: "The same series wrapped in an envelope, to exercise `response_path`.",
    response_path: "/data/series",
    shape: "rows",
  },
  {
    methods: ["GET"],
    path: "/csv?group=region",
    summary: "text/csv of the sales table — arrives as a string, or save it and import as a file.",
    shape: "text",
  },
  {
    methods: ["GET"],
    path: "/flaky?rate=0.3&status=500",
    summary: "Fails at the given rate, so a datasource shows its error next to the last good value.",
    shape: "object",
  },
  {
    methods: ["GET"],
    path: "/slow?ms=1500",
    summary: "Answers after a delay (max 30s), for timeout and in-flight behaviour.",
    shape: "object",
  },
  {
    methods: ["GET"],
    path: "/secure/metrics",
    summary: "Same snapshot, behind a bearer token.",
    auth: "Authorization: Bearer <token>",
    shape: "object",
  },
  {
    methods: ["GET"],
    path: "/secure/series?points=30",
    summary: "Series behind an API key header.",
    auth: "X-API-Key: <key>",
    shape: "rows",
  },
  {
    methods: ["POST"],
    path: "/query",
    summary: 'Body {"metrics":["cpu"],"points":40,"interval":60000,"group":"region"} → rows under `data`.',
    response_path: "/data",
    shape: "rows",
  },
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    path: "/echo",
    summary: "Reflects method, query, headers and body — the quickest check that a request arrived as intended.",
    shape: "object",
  },
  {
    methods: ["GET"],
    path: "/sse?interval=1000",
    summary: "Server-sent `tick` events. Not consumable as a datasource yet — use the tester below.",
    shape: "stream",
  },
  {
    methods: ["GET"],
    path: "/ws?interval=1000",
    summary: "WebSocket ticks; send {\"type\":\"subscribe\",\"metrics\":[...]} to change the payload.",
    shape: "stream",
  },
];
