import { SCHEMA_VERSION } from "shared";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/v1/health": () =>
      Response.json({ ok: true, schema_version: SCHEMA_VERSION }),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`relay listening on ${server.url}`);
