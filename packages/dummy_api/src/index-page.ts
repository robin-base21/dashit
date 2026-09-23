import { ENDPOINTS } from "./catalog.ts";

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => escapes[c] ?? c);
}

/** A plain served page (not an artifact): the endpoint list plus testers for SSE and WebSocket. */
export function indexPage(origin: string, token: string, apiKey: string): string {
  const rows = ENDPOINTS.map((e) => {
    const url = `${origin}${e.path}`;
    const meta = [
      e.auth ? `<span class="pill auth">${esc(e.auth)}</span>` : "",
      e.response_path ? `<span class="pill">response_path <code>${esc(e.response_path)}</code></span>` : "",
      `<span class="pill">${e.shape}</span>`,
    ].join("");
    return `<tr>
      <td class="m">${e.methods.map((m) => `<span class="method">${m}</span>`).join("")}</td>
      <td>
        <a href="${esc(url)}" target="_blank" rel="noreferrer"><code>${esc(e.path)}</code></a>
        <p>${esc(e.summary)}</p>
        <div class="meta">${meta}</div>
      </td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dummy_api</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b66; --line: #e3e3df; --card: #fff; --accent: #2f6f4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #e9e9e6; --muted: #9a9a93; --line: #2c2c31; --card: #1d1d22; --accent: #7fc8a0; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 56rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2.5rem 0 .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  p { margin: .25rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  td { border-top: 1px solid var(--line); padding: .8rem .5rem; vertical-align: top; }
  td.m { width: 6.5rem; }
  td p { color: var(--muted); font-size: .9rem; }
  .method { display: inline-block; font: 600 .7rem/1.4 ui-monospace, monospace; background: var(--card);
    border: 1px solid var(--line); border-radius: 4px; padding: 0 .35rem; margin: 0 .2rem .2rem 0; }
  .meta { margin-top: .35rem; display: flex; flex-wrap: wrap; gap: .35rem; }
  .pill { font-size: .72rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: .1rem .5rem; }
  .pill.auth { border-color: var(--accent); color: var(--accent); }
  .creds { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .75rem 1rem; margin-top: 1rem; }
  .tester { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; }
  .tester button { font: inherit; padding: .3rem .8rem; border-radius: 6px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); cursor: pointer; }
  .tester button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  pre { margin: .75rem 0 0; max-height: 14rem; overflow: auto; font-size: .78rem;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .6rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); }
</style>
</head>
<body>
<main>
  <h1>dummy_api</h1>
  <p>Random-but-coherent data for manual DashIt datasource testing. Every value is a smooth function
     of the clock, so polling looks like a live system rather than noise. CORS is open.</p>
  <div class="creds">
    <p><code>Authorization: Bearer ${esc(token)}</code></p>
    <p><code>X-API-Key: ${esc(apiKey)}</code></p>
  </div>

  <h2>Endpoints</h2>
  <table><tbody>${rows}</tbody></table>

  <h2>Streams</h2>
  <div class="grid">
    <div class="tester">
      <button id="sse-btn" aria-pressed="false">Connect SSE</button>
      <span id="sse-state">idle</span>
      <pre id="sse-log"></pre>
    </div>
    <div class="tester">
      <button id="ws-btn" aria-pressed="false">Connect WebSocket</button>
      <span id="ws-state">idle</span>
      <pre id="ws-log"></pre>
    </div>
  </div>
</main>
<script type="module">
  const origin = location.origin;
  function logger(pre) {
    const lines = [];
    return (text) => {
      lines.unshift(new Date().toLocaleTimeString() + "  " + text);
      pre.textContent = lines.slice(0, 40).join("\\n");
    };
  }
  const sseLog = logger(document.getElementById("sse-log"));
  const sseState = document.getElementById("sse-state");
  let sse = null;
  document.getElementById("sse-btn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (sse) { sse.close(); sse = null; btn.textContent = "Connect SSE"; btn.ariaPressed = "false"; sseState.textContent = "closed"; return; }
    sse = new EventSource(origin + "/sse?interval=1000");
    btn.textContent = "Disconnect"; btn.ariaPressed = "true"; sseState.textContent = "connecting";
    sse.addEventListener("open", () => { sseState.textContent = "open"; });
    sse.addEventListener("tick", (ev) => sseLog(ev.data));
    sse.addEventListener("error", () => { sseState.textContent = "error"; });
  });

  const wsLog = logger(document.getElementById("ws-log"));
  const wsState = document.getElementById("ws-state");
  let ws = null;
  document.getElementById("ws-btn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (ws) { ws.close(); return; }
    ws = new WebSocket(origin.replace(/^http/, "ws") + "/ws?interval=1000");
    btn.textContent = "Disconnect"; btn.ariaPressed = "true"; wsState.textContent = "connecting";
    ws.addEventListener("open", () => { wsState.textContent = "open"; });
    ws.addEventListener("message", (ev) => wsLog(ev.data));
    ws.addEventListener("close", () => {
      ws = null; wsState.textContent = "closed";
      btn.textContent = "Connect WebSocket"; btn.ariaPressed = "false";
    });
  });
</script>
</body>
</html>`;
}
