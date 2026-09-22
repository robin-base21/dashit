<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import type { EdgeRow, NodeKey } from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as Tabs from '$lib/components/ui/tabs';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { Sandbox, type JsonValue, type RunResult } from '$lib/sandbox/sandbox';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SaveIcon from '@lucide/svelte/icons/save';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	const db = getDb();
	const dataflow = getDataflow();
	const id = $derived(page.params.id!);

	const transformer = liveQuery(db, (d) => d.call('getTransformer', id), ['transformers']);
	const versions = liveQuery(db, (d) => d.call('listTransformerVersions', id), ['transformer_versions', 'transformers']);
	const edges = liveQuery(db, (d) => d.call('listEdges'), ['edges']);
	const datasources = liveQuery(db, (d) => d.call('listDatasources'), ['datasources']);
	const transformers = liveQuery(db, (d) => d.call('listTransformers'), ['transformers']);

	const inputs = $derived(
		(edges.value ?? []).filter((e) => e.consumer_kind === 'transformer' && e.consumer_id === id).sort((a, b) => a.position - b.position)
	);
	const current = $derived(versions.value?.find((v) => v.id === transformer.value?.current_version_id) ?? versions.value?.[0]);

	// The editor draft is seeded from the current version and edited freely.
	let code = $derived(current?.code ?? '');
	const dirty = $derived(code !== (current?.code ?? ''));

	let name = $derived(transformer.value?.name ?? '');
	let timeoutMs = $derived(String(transformer.value?.timeout_ms ?? 2000));

	const producerLabel = $derived.by(() => {
		const m = new Map<string, string>();
		for (const d of datasources.value ?? []) m.set(`datasource:${d.id}`, d.name);
		for (const t of transformers.value ?? []) m.set(`transformer:${t.id}`, t.name);
		return m;
	});
	const candidates = $derived(
		[...producerLabel.entries()].filter(([key]) => key !== `transformer:${id}` && !inputs.some((e) => `${e.producer_kind}:${e.producer_id}` === key))
	);

	let addKey = $state('');

	const sandbox = new Sandbox();
	onDestroy(() => sandbox.destroy());
	let running = $state(false);
	let result = $state<RunResult | null>(null);

	const liveState = $derived(dataflow.get(`transformer:${id}`));

	function inputValues(): JsonValue[] {
		return inputs.map((e) => (dataflow.get(`${e.producer_kind}:${e.producer_id}` as NodeKey).value ?? null) as JsonValue);
	}

	async function run() {
		running = true;
		try {
			result = await sandbox.run(code, inputValues(), Number(timeoutMs) || 2000);
		} finally {
			running = false;
		}
	}

	async function save(note = 'manual edit') {
		try {
			await db.call('saveTransformerVersion', { transformer_id: id, code, site_id: db.info?.siteId ?? '', note });
			toast.success('Saved as a new version');
		} catch (e) {
			toast.error('Could not save', { description: e instanceof Error ? e.message : String(e) });
		}
	}

	async function saveMeta() {
		const t = transformer.value;
		if (!t) return;
		const n = name.trim() || t.name;
		const ms = Math.max(100, Number(timeoutMs) || 2000);
		if (n !== t.name || ms !== t.timeout_ms) await db.call('updateTransformer', id, { name: n, timeout_ms: ms });
	}

	async function addInput() {
		if (!addKey) return;
		const [kind, pid] = addKey.split(':') as ['datasource' | 'transformer', string];
		try {
			await db.call('addEdge', { producer_kind: kind, producer_id: pid, consumer_kind: 'transformer', consumer_id: id, position: inputs.length });
			addKey = '';
		} catch (e) {
			toast.error('Could not add input', { description: e instanceof Error ? e.message : String(e) });
		}
	}

	async function removeInput(e: EdgeRow) {
		await db.call('removeEdge', e.id);
		await renumber(inputs.filter((x) => x.id !== e.id));
	}

	async function move(e: EdgeRow, dir: -1 | 1) {
		const i = inputs.indexOf(e);
		const j = i + dir;
		if (j < 0 || j >= inputs.length) return;
		const next = [...inputs];
		[next[i], next[j]] = [next[j]!, next[i]!];
		await renumber(next);
	}

	async function renumber(list: EdgeRow[]) {
		await Promise.all(list.map((e, i) => (e.position === i ? null : db.call('setEdgePosition', e.id, i))));
	}

	async function restore(versionId: string) {
		await db.call('setCurrentVersion', id, versionId);
		toast('Version restored');
	}

	async function remove() {
		await db.call('deleteTransformer', id);
		await goto(resolve('/transformers'));
	}

	function onCodeKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			void run();
		} else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			if (dirty) void save();
		} else if (e.key === 'Tab') {
			e.preventDefault();
			const el = e.currentTarget as HTMLTextAreaElement;
			const { selectionStart, selectionEnd } = el;
			code = code.slice(0, selectionStart) + '  ' + code.slice(selectionEnd);
			queueMicrotask(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2));
		}
	}

	function pretty(v: unknown): string {
		const s = JSON.stringify(v, null, 2) ?? 'undefined';
		return s.length > 20_000 ? s.slice(0, 20_000) + '\n…' : s;
	}
</script>

<svelte:head><title>{transformer.value?.name ?? 'Transformer'} · DashIt</title></svelte:head>

{#if transformer.value}
	<div class="flex h-full flex-col gap-4 p-6">
		<div class="flex flex-wrap items-end gap-3">
			<div class="grid gap-1">
				<Label for="t-name">Name</Label>
				<Input id="t-name" bind:value={name} onblur={saveMeta} class="w-64" />
			</div>
			<div class="grid gap-1">
				<Label for="t-timeout">Timeout (ms)</Label>
				<Input id="t-timeout" type="number" min="100" bind:value={timeoutMs} onblur={saveMeta} class="w-28" />
			</div>
			<div class="ml-auto flex items-center gap-2">
				<Badge variant={liveState.status === 'error' ? 'destructive' : liveState.status === 'ok' ? 'outline' : 'secondary'} title={liveState.error ?? ''}>
					live: {liveState.status}
				</Badge>
				<Button variant="ghost" size="icon-sm" aria-label="Delete transformer" onclick={remove}>
					<Trash2Icon class="size-4" />
				</Button>
			</div>
		</div>

		<div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[18rem_1fr]">
			<div class="flex flex-col gap-4">
				<Card.Root>
					<Card.Header>
						<Card.Title class="text-sm">Inputs</Card.Title>
						<Card.Description>Available in your code as <code>inputs[i]</code>.</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-2">
						<ol class="space-y-1 text-sm" aria-label="Inputs">
							{#each inputs as e, i (e.id)}
								{@const key = `${e.producer_kind}:${e.producer_id}`}
								<li class="flex items-center gap-1 rounded border px-2 py-1" data-input-index={i}>
									<span class="w-5 shrink-0 font-mono text-xs text-muted-foreground">[{i}]</span>
									<span class="min-w-0 flex-1 truncate">{producerLabel.get(key) ?? key}</span>
									<Badge variant="secondary" class="text-[10px]">{e.producer_kind}</Badge>
									<Button size="icon-xs" variant="ghost" aria-label="Move up" disabled={i === 0} onclick={() => move(e, -1)}><ArrowUpIcon class="size-3" /></Button>
									<Button size="icon-xs" variant="ghost" aria-label="Move down" disabled={i === inputs.length - 1} onclick={() => move(e, 1)}><ArrowDownIcon class="size-3" /></Button>
									<Button size="icon-xs" variant="ghost" aria-label="Remove input" onclick={() => removeInput(e)}><XIcon class="size-3" /></Button>
								</li>
							{:else}
								<li class="text-xs text-muted-foreground">No inputs yet.</li>
							{/each}
						</ol>
						<div class="flex gap-1">
							<Select.Root type="single" bind:value={addKey}>
								<Select.Trigger class="min-w-0 flex-1" aria-label="Add input">{producerLabel.get(addKey) ?? 'Pick a source…'}</Select.Trigger>
								<Select.Content>
									{#each candidates as [key, label] (key)}
										<Select.Item value={key} {label}>{label} <span class="text-muted-foreground">· {key.split(':')[0]}</span></Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							<Button size="icon-sm" variant="outline" aria-label="Add" disabled={!addKey} onclick={addInput}><PlusIcon class="size-4" /></Button>
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root class="min-h-0 flex-1">
					<Card.Header>
						<Card.Title class="flex items-center gap-2 text-sm"><HistoryIcon class="size-4" /> Versions</Card.Title>
					</Card.Header>
					<Card.Content>
						<ul class="space-y-1 text-xs" aria-label="Versions">
							{#each versions.value ?? [] as v (v.id)}
								<li class="flex items-center gap-2 rounded border px-2 py-1" data-version-id={v.id}>
									<div class="min-w-0 flex-1">
										<div class="truncate">{v.note ?? 'edit'}</div>
										<div class="text-muted-foreground">{new Date(v.created_at).toLocaleString()}</div>
									</div>
									{#if v.id === transformer.value.current_version_id}
										<Badge variant="outline">current</Badge>
									{:else}
										<Button size="xs" variant="ghost" onclick={() => restore(v.id)}>Restore</Button>
									{/if}
								</li>
							{/each}
						</ul>
					</Card.Content>
				</Card.Root>
			</div>

			<div class="flex min-h-0 flex-col gap-3">
				<div class="flex items-center gap-2">
					<Label for="t-code" class="text-sm">Code <span class="font-normal text-muted-foreground">— body of <code>function transform(inputs)</code></span></Label>
					<div class="ml-auto flex items-center gap-2">
						{#if dirty}<Badge variant="secondary">unsaved</Badge>{/if}
						<Button size="sm" variant="outline" onclick={run} disabled={running} title="Ctrl/⌘+Enter">
							<PlayIcon class="size-4" />
							Run
						</Button>
						<Button size="sm" onclick={() => save()} disabled={!dirty} title="Ctrl/⌘+S">
							<SaveIcon class="size-4" />
							Save version
						</Button>
					</div>
				</div>
				<textarea
					id="t-code"
					class="min-h-56 flex-1 resize-y rounded-md border bg-card p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-ring"
					spellcheck="false"
					bind:value={code}
					onkeydown={onCodeKeydown}
				></textarea>

				<Tabs.Root value="run" class="min-h-0">
					<Tabs.List>
						<Tabs.Trigger value="run">Run output</Tabs.Trigger>
						<Tabs.Trigger value="live">Live output</Tabs.Trigger>
						<Tabs.Trigger value="inputs">Current inputs</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="run">
						{#if !result}
							<p class="p-2 text-xs text-muted-foreground">Run the draft against the current inputs to see its output here.</p>
						{:else}
							<div class="space-y-2" data-testid="run-output">
								<div class="flex items-center gap-2 text-xs">
									<Badge variant={result.ok ? 'outline' : 'destructive'}>{result.ok ? 'ok' : result.error.name}</Badge>
									<span class="text-muted-foreground">{result.durationMs.toFixed(1)} ms</span>
								</div>
								{#if !result.ok}
									<pre class="overflow-auto rounded bg-destructive/10 p-2 text-xs text-destructive">{result.error.message}</pre>
								{:else}
									<pre class="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{pretty(result.output)}</pre>
								{/if}
								{#if result.logs.length}
									<pre class="max-h-40 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">{result.logs.join('\n')}</pre>
								{/if}
							</div>
						{/if}
					</Tabs.Content>
					<Tabs.Content value="live">
						{#if liveState.status === 'error'}
							<pre class="overflow-auto rounded bg-destructive/10 p-2 text-xs text-destructive">{liveState.error}</pre>
						{:else}
							<pre class="max-h-64 overflow-auto rounded bg-muted p-2 text-xs" data-testid="live-output">{pretty(liveState.value)}</pre>
						{/if}
					</Tabs.Content>
					<Tabs.Content value="inputs">
						<pre class="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{pretty(inputValues())}</pre>
					</Tabs.Content>
				</Tabs.Root>
			</div>
		</div>
	</div>
{:else if !transformer.loading}
	<div class="p-6 text-sm text-muted-foreground">Transformer not found. <a class="underline" href={resolve('/transformers')}>Back to transformers</a></div>
{/if}
