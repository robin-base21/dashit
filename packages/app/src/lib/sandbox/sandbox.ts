/**
 * Transformer sandbox: an opaque-origin iframe whose CSP forbids all network, hosting a
 * Worker per run that executes user code via `new Function`. See ARCHITECTURE.md §7.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type RunResult =
  | { ok: true; output: JsonValue; logs: string[]; durationMs: number }
  | { ok: false; error: { name: string; message: string; stack?: string }; logs: string[]; durationMs: number };

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; webrtc 'block'";

// Runs inside the Worker. Kept as a string so it can be blob-loaded under the iframe's CSP.
const WORKER_SOURCE = String.raw`
const logs = [];
const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => { if (logs.length < 200) logs.push(a.map(fmt).join(' ')); };
self.onmessage = async (ev) => {
  const { runId, code, inputs } = ev.data;
  const t0 = performance.now();
  try {
    const fn = new Function('inputs', code);
    let out = fn(inputs);
    if (out && typeof out.then === 'function') out = await out;
    if (out === undefined) out = null;
    JSON.stringify(out); // reject cyclic / non-JSON output early
    self.postMessage({ runId, ok: true, output: out, logs, durationMs: performance.now() - t0 });
  } catch (e) {
    const err = e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : { name: 'Error', message: String(e) };
    self.postMessage({ runId, ok: false, error: err, logs, durationMs: performance.now() - t0 });
  }
};
`;

// Runs inside the iframe document. Owns the workers; talks to the host over a MessagePort.
const CONTROLLER_SOURCE = String.raw`
const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
const running = new Map();
let port = null;
addEventListener('message', (ev) => {
  if (ev.source !== parent || !ev.ports[0]) return;
  port = ev.ports[0];
  port.onmessage = (m) => {
    const msg = m.data;
    if (msg.type === 'run') start(msg);
    else if (msg.type === 'cancel') kill(msg.runId, 'cancelled');
  };
  port.postMessage({ type: 'ready' });
});
function start({ runId, code, inputs, timeoutMs }) {
  const w = new Worker(workerUrl);
  const timer = setTimeout(() => kill(runId, 'timeout'), timeoutMs);
  running.set(runId, { w, timer });
  w.onmessage = (m) => { finish(runId); port.postMessage(m.data); };
  w.onerror = (e) => { finish(runId); port.postMessage({ runId, ok: false, error: { name: 'WorkerError', message: e.message || 'worker error' }, logs: [], durationMs: 0 }); e.preventDefault(); };
  w.postMessage({ runId, code, inputs });
}
function finish(runId) { const r = running.get(runId); if (!r) return; clearTimeout(r.timer); r.w.terminate(); running.delete(runId); }
function kill(runId, why) {
  if (!running.has(runId)) return;
  finish(runId);
  port.postMessage({ runId, ok: false, error: { name: why === 'timeout' ? 'TimeoutError' : 'CancelledError', message: why === 'timeout' ? 'transformer exceeded its time limit' : 'run cancelled' }, logs: [], durationMs: 0 });
}
`;

function srcdoc(): string {
  const worker = JSON.stringify(WORKER_SOURCE);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>const WORKER_SOURCE=${worker};${CONTROLLER_SOURCE}</script></body></html>`;
}

export class Sandbox {
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, (r: RunResult) => void>();
  private seq = 0;

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.style.display = "none";
      iframe.srcdoc = srcdoc();
      const channel = new MessageChannel();
      const boot = setTimeout(() => reject(new Error("sandbox failed to start")), 5000);
      channel.port1.onmessage = (m) => {
        const msg = m.data as { type?: string; runId?: string } & RunResult;
        if (msg.type === "ready") {
          clearTimeout(boot);
          resolve();
          return;
        }
        const done = msg.runId ? this.pending.get(msg.runId) : undefined;
        if (done) {
          this.pending.delete(msg.runId!);
          const { runId: _r, type: _t, ...rest } = msg;
          done(rest as RunResult);
        }
      };
      iframe.onload = () => iframe.contentWindow!.postMessage({ type: "init" }, "*", [channel.port2]);
      document.body.appendChild(iframe);
      this.iframe = iframe;
      this.port = channel.port1;
    });
    return this.ready;
  }

  async run(code: string, inputs: JsonValue[], timeoutMs = 2000): Promise<RunResult> {
    await this.ensure();
    const runId = `r${++this.seq}`;
    return new Promise<RunResult>((resolve) => {
      this.pending.set(runId, resolve);
      this.port!.postMessage({ type: "run", runId, code, inputs, timeoutMs });
    });
  }

  destroy(): void {
    this.port?.close();
    this.iframe?.remove();
    this.iframe = null;
    this.port = null;
    this.ready = null;
    for (const done of this.pending.values()) {
      done({ ok: false, error: { name: "CancelledError", message: "sandbox destroyed" }, logs: [], durationMs: 0 });
    }
    this.pending.clear();
  }
}
