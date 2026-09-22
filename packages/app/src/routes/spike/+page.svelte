<script lang="ts">
	import { onMount } from 'svelte';
	import { Sandbox, type RunResult } from '$lib/sandbox/sandbox';
	import type { SpikeReport } from './spike.worker.ts';

	let db = $state<SpikeReport | null>(null);
	let sandbox = $state<Record<string, RunResult> | null>(null);
	let error = $state<string | null>(null);
	let done = $state(false);
	let progress = $state<string[]>([]);

	// Every egress channel user code could try. All must be blocked by the iframe CSP.
	const PROBE = String.raw`
		return (async () => {
			const out = {};
			const attempt = async (name, fn) => {
				try {
					const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
					out[name] = 'ALLOWED:' + String(r).slice(0, 40);
				} catch (e) { out[name] = 'blocked:' + (e && e.name || 'Error'); }
			};
			out.rtc = typeof RTCPeerConnection === 'undefined' ? 'blocked:undefined' : 'ALLOWED:RTCPeerConnection';
			await attempt('fetch', () => fetch('https://example.com/'));
			await attempt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onload = () => res('loaded'); x.onerror = () => rej(new Error('NetworkError')); x.open('GET', 'https://example.com/'); x.send(); }));
			await attempt('websocket', () => new Promise((res, rej) => { const w = new WebSocket('wss://example.com/'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('WsError')); }));
			await attempt('import', () => import('https://example.com/x.js'));
			await attempt('eventsource', () => new Promise((res, rej) => { const s = new EventSource('https://example.com/'); s.onopen = () => res('open'); s.onerror = () => rej(new Error('EsError')); }));
			await attempt('nestedWorkerFetch', () => new Promise((res, rej) => {
				const src = 'fetch("https://example.com/").then(r => postMessage("ok:" + r.status), e => postMessage("blocked:" + e.name))';
				const w = new Worker(URL.createObjectURL(new Blob([src])));
				w.onmessage = (m) => String(m.data).startsWith('ok') ? res(m.data) : rej(new Error(String(m.data).slice(8)));
				w.onerror = (e) => rej(new Error('WorkerError'));
			}));
			return out;
		})();
	`;

	onMount(async () => {
		try {
			const worker = new Worker(new URL('./spike.worker.ts', import.meta.url), { type: 'module' });
			const report = await new Promise<SpikeReport>((resolve, reject) => {
				worker.onmessage = (ev) => {
					if (ev.data.progress) {
						progress = [...progress, `${new Date(ev.data.at).toISOString().slice(11, 23)} ${ev.data.progress}`];
						console.log('[spike]', ev.data.progress);
						return;
					}
					resolve(ev.data.report);
				};
				worker.onerror = (ev) => reject(new Error(ev.message));
				worker.postMessage({ marker: new Date().toISOString(), reset: new URLSearchParams(location.search).has('reset') });
			});
			db = report;

			const sb = new Sandbox();
			const probes = await sb.run(PROBE, [], 15000);
			const echo = await sb.run('return inputs[0].map(x => x * 2)', [[1, 2, 3]]);
			const loop = await sb.run('while (true) {}', [], 300);
			const throws = await sb.run('throw new TypeError("boom")', []);
			const cyclic = await sb.run('const a = {}; a.self = a; return a', []);
			sandbox = { probes, echo, loop, throws, cyclic };
			sb.destroy();
		} catch (e) {
			error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
		} finally {
			done = true;
			(window as unknown as { __spike: unknown }).__spike = { db, sandbox, error };
		}
	});
</script>

<main class="p-6 font-mono text-sm" data-done={done}>
	<h1 class="text-lg font-bold">Phase 0 spike</h1>
	{#if error}<pre class="text-red-600">{error}</pre>{/if}
	<h2 class="mt-4 font-bold">Progress</h2>
	<pre>{progress.join('\n')}</pre>
	<h2 class="mt-4 font-bold">Database</h2>
	<pre>{JSON.stringify(db, null, 2)}</pre>
	<h2 class="mt-4 font-bold">Sandbox</h2>
	<pre>{JSON.stringify(sandbox, null, 2)}</pre>
</main>
