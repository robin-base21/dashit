/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { base, build, files, version } from "$service-worker";

const sw = globalThis.self as unknown as ServiceWorkerGlobalScope;

const CACHE = `dashit-${version}`;
// The SPA fallback page, fetched via the root URL (static hosts do not always expose /index.html).
const SHELL = `${base}/`;
// `build` is empty during `vite dev`, where there is no fallback page to cache either.
const DEV = build.length === 0;
const ASSETS = DEV ? [] : [...build, ...files, SHELL];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (DEV || url.origin !== sw.location.origin || url.pathname.startsWith(`${base}/api/`)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      // Immutable build assets and static files: cache first.
      if (ASSETS.includes(url.pathname)) {
        const hit = await cache.match(url.pathname);
        if (hit) return hit;
      }

      // Navigations: network first so a new deployment is picked up, shell from cache offline.
      if (request.mode === "navigate") {
        try {
          return await fetch(request);
        } catch {
          const shell = await cache.match(SHELL);
          if (shell) return shell;
          throw new Error("offline and no cached shell");
        }
      }

      try {
        const response = await fetch(request);
        if (response.ok && !response.headers.get("cache-control")?.includes("no-store")) {
          void cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        const hit = await cache.match(request);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
