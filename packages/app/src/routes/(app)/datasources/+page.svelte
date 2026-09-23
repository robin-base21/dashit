<script lang="ts">
	import type { DatasourceRow } from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { getRuntime } from '$lib/dataflow/runtime-context';
	import { KIND_META } from '$lib/elements/kinds';
	import DatasourceDialog from '$lib/components/datasources/datasource-dialog.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	const db = getDb();
	const dataflow = getDataflow();
	const runtime = getRuntime();

	const datasources = liveQuery(db, (d) => d.call('listDatasources'), ['datasources']);
	const elements = liveQuery(db, (d) => d.call('listElements'), ['elements']);
	const cache = liveQuery(db, (d) => d.call('listDatasourceCache'), ['datasource_cache']);

	const editables = $derived((elements.value ?? []).filter((e) => KIND_META[e.kind].category === 'editable'));
	const elementTitle = $derived(new Map((elements.value ?? []).map((e) => [e.id, e.title || KIND_META[e.kind].label])));
	const cacheById = $derived(new Map((cache.value ?? []).map((c) => [c.datasource_id, c])));

	let dialogOpen = $state(false);
	let editing = $state<DatasourceRow | null>(null);

	function create() {
		editing = null;
		dialogOpen = true;
	}

	function edit(ds: DatasourceRow) {
		editing = ds;
		dialogOpen = true;
	}

	async function remove(ds: DatasourceRow) {
		await db.call('deleteDatasource', ds.id);
		toast(`Deleted “${ds.name}”`);
	}

	function preview(ds: DatasourceRow): string {
		const s = dataflow.get(`datasource:${ds.id}`);
		if (s.status === 'error') return `Error: ${s.error}`;
		if (s.status === 'inactive') return 'Inactive — nothing on the dashboard reads this source yet.';
		if (s.status === 'running') return 'Fetching…';
		if (s.status !== 'ok') return s.status;
		const text = JSON.stringify(s.value, null, 1) ?? 'null';
		return text.length > 400 ? text.slice(0, 400) + '…' : text;
	}

	function recordCount(ds: DatasourceRow): number | null {
		const v = dataflow.get(`datasource:${ds.id}`).value;
		return Array.isArray(v) ? v.length : null;
	}

	function ago(ts: number | null | undefined): string {
		if (!ts) return 'never';
		const s = Math.round((Date.now() - ts) / 1000);
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		return new Date(ts).toLocaleTimeString();
	}
</script>

<svelte:head><title>Datasources · DashIt</title></svelte:head>

<div class="p-6">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Datasources</h1>
			<p class="text-sm text-muted-foreground">Static values, editable elements, and external APIs polled from this browser.</p>
		</div>
		<Button onclick={create}>
			<PlusIcon class="size-4" />
			New datasource
		</Button>
	</div>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each datasources.value ?? [] as ds (ds.id)}
			{@const c = cacheById.get(ds.id)}
			{@const active = dataflow.activeDatasourceIds.has(ds.id)}
			<Card.Root data-datasource-id={ds.id}>
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<span class="truncate">{ds.name}</span>
						<Badge variant="secondary">{ds.kind}</Badge>
						{#if active}
							<Badge variant="outline">active</Badge>
						{/if}
						{#if ds.track_mode}
							<Badge variant="outline" data-testid="tracked-badge">tracked</Badge>
						{/if}
					</Card.Title>
					<Card.Description>
						{#if ds.kind === 'internal'}
							From “{elementTitle.get(ds.source_element_id ?? '') ?? 'deleted element'}”
						{:else if ds.kind === 'static'}
							Constant value
						{:else}
							<span class="break-all">{ds.method} {ds.url}</span> · every {Math.round((ds.poll_interval_ms ?? 0) / 1000)}s
							· fetched {ago(c?.fetched_at)}
						{/if}
						{#if recordCount(ds) !== null}
							· <span data-testid="record-count">{recordCount(ds)}</span> records
						{/if}
					</Card.Description>
					<Card.Action class="flex items-center gap-0.5">
						{#if ds.kind === 'external'}
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Fetch now"
								disabled={runtime.states.get(ds.id)?.busy}
								onclick={() => runtime.fetchNow(ds.id)}
							>
								<RefreshCwIcon class={['size-4', runtime.states.get(ds.id)?.busy && 'animate-spin']} />
							</Button>
						{/if}
						<Button size="icon-sm" variant="ghost" aria-label="Edit datasource" onclick={() => edit(ds)}>
							<PencilIcon class="size-4" />
						</Button>
						<Button size="icon-sm" variant="ghost" aria-label="Delete datasource" onclick={() => remove(ds)}>
							<Trash2Icon class="size-4" />
						</Button>
					</Card.Action>
				</Card.Header>
				<Card.Content class="space-y-2">
					{#if c?.error}
						<p class="text-xs text-destructive" data-testid="fetch-error">Last fetch failed: {c.error}</p>
					{/if}
					<pre class="max-h-40 overflow-auto rounded bg-muted p-2 text-xs" data-testid="preview">{preview(ds)}</pre>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No datasources yet.</p>
		{/each}
	</div>
</div>

<DatasourceDialog bind:open={dialogOpen} {editing} {editables} />
