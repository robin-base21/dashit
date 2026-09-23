# dummy_api

A throwaway Bun server that hands out random-but-coherent data, so `external` datasources can be
exercised by hand without depending on a third-party API. Not part of the product; nothing here
ships and the relay never talks to it.

```sh
bun run dev:dummy            # http://localhost:3100
PORT=4000 bun run dev:dummy
```

Open <http://localhost:3100> in a browser for the endpoint list with live SSE and WebSocket testers.

CORS is wide open (the origin is reflected, as are the requested preflight headers — `*` does not
cover `Authorization`), because DashIt polls these URLs from the main thread.

## Values

Every number is a pure function of its seed and the clock — three octaves of cosine-interpolated
value noise. Nothing is stored, so restarting changes nothing, and a series endpoint can return a
coherent history whose window slides as you poll. Metrics: `cpu`, `memory`, `requests`,
`latency_ms`, `errors`.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/series?points=30&interval=60000&metrics=cpu,memory` | Rows with `label` (x) and one column per metric |
| GET | `/sales?group=region\|quarter\|channel` | Categorical rows: `revenue`, `units`, `orders` |
| GET | `/metrics` | One flat object, for aggregations |
| GET | `/nested?points=20` | Same series under an envelope — `response_path` `/data/series` |
| GET | `/csv?group=region` | `text/csv`; save it to import as a static file datasource |
| GET | `/flaky?rate=0.3&status=500` | Fails at the given rate |
| GET | `/slow?ms=1500` | Delays the response (max 30s) |
| GET | `/secure/metrics` | Needs `Authorization: Bearer $DUMMY_API_TOKEN` |
| GET | `/secure/series?points=30` | Needs `X-API-Key: $DUMMY_API_KEY` |
| POST | `/query` | `{"metrics":["cpu"],"points":40,"interval":60000}` or `{"group":"region"}` → rows under `data` |
| any | `/echo` | Reflects method, query, headers and body |
| GET | `/sse?interval=1000` | `text/event-stream`, `tick` events |
| GET | `/ws?interval=1000` | WebSocket ticks; `{"type":"subscribe","metrics":[...],"interval":2000}` re-arms |

Credentials default to `dev-token` / `dev-key` (`DUMMY_API_TOKEN`, `DUMMY_API_KEY`) and are printed
at startup and on the index page.

## Using one as a datasource

In DashIt: **Datasources → New → external**, url `http://localhost:3100/series?points=30`, poll
interval 5000, and bind a chart to it with `label` as the x field. For `/nested`, set
`response_path` to `/data/series`. For `/secure/metrics`, add `Authorization: Bearer dev-token`
under headers. For `/query`, method `POST` with a JSON body.

`/sse` and `/ws` are **not** consumable as datasources — polling is the only transport in Phase 1.5
(WebSocket datasources are Phase 5+, ARCHITECTURE.md §10). They exist so the streams are ready when
that lands; use the browser index page to watch them now.
