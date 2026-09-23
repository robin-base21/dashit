<script lang="ts">
	import { fieldsOf, isEditable, type ElementRow } from 'shared';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { KIND_META } from '$lib/elements/kinds';
	import { SCHEMAS } from '$lib/elements/schema';

	let { element, open = $bindable(false) }: { element: ElementRow; open?: boolean } = $props();

	const db = getDb();
	const dataflow = getDataflow();

	const meta = $derived(KIND_META[element.kind]);
	const schema = $derived(SCHEMAS[element.kind]);
	const editable = $derived(isEditable(element.kind));

	const bound = $derived(dataflow.datasetOf(element.id));

	// What an editable currently emits. The component is only mounted while the dialog is open
	// (see element-card.svelte), so this does not run for every card on the dashboard.
	const emitted = liveQuery(
		db,
		(d) => (editable ? d.call('readElementData', element.id) : Promise.resolve(undefined)),
		['task_items', 'table_columns', 'table_rows', 'table_cells']
	);

	const live = $derived(
		editable ? emitted.value : bound.state.status === 'ok' ? bound.state.value : undefined
	);
	const liveFields = $derived(live === undefined ? [] : fieldsOf(live));
	const liveSample = $derived.by(() => {
		if (live === undefined) return null;
		const rows = Array.isArray(live) ? live : [live];
		return rows.length === 0 ? null : JSON.stringify(rows[0], null, 2);
	});

	// Name the actual source, so it is obvious which binding the sample below came from.
	const datasources = liveQuery(db, (d) => d.call('listDatasources'), ['datasources']);
	const transformers = liveQuery(db, (d) => d.call('listTransformers'), ['transformers']);
	const producerName = $derived.by(() => {
		const key = bound.producer;
		if (!key) return null;
		const [kind, id] = key.split(':');
		const found =
			kind === 'datasource'
				? (datasources.value ?? []).find((x) => x.id === id)
				: (transformers.value ?? []).find((x) => x.id === id);
		return found?.name ?? 'unknown source';
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<meta.icon class="size-4" />
				{meta.label} data format
			</Dialog.Title>
			<Dialog.Description>
				{schema.direction === 'produces'
					? 'What this element emits when an internal datasource reads it.'
					: 'What a datasource or transformer must produce to feed this element.'}
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<p class="text-sm text-muted-foreground">{schema.summary}</p>

			<div class="grid gap-2">
				<h3 class="text-xs font-semibold tracking-wide text-foreground uppercase">Fields</h3>
				<dl class="grid gap-1.5 text-sm">
					{#each schema.fields as f (f.name)}
						<div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2">
							<dt class="font-mono text-xs">{f.name}</dt>
							<dd class="text-xs text-muted-foreground">
								<span class="font-mono">{f.type}</span> — {f.note}
							</dd>
						</div>
					{/each}
				</dl>
			</div>

			<div class="grid gap-2">
				<h3 class="text-xs font-semibold tracking-wide text-foreground uppercase">Example</h3>
				<pre class="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs" data-testid="schema-example">{JSON.stringify(
						schema.example,
						null,
						2
					)}</pre>
			</div>

			<div class="grid gap-2">
				<h3 class="flex items-center gap-2 text-xs font-semibold tracking-wide text-foreground uppercase">
					{editable ? 'Emitting now' : 'Arriving now'}
					{#if !editable && producerName}<Badge variant="outline">{producerName}</Badge>{/if}
				</h3>
				{#if live === undefined}
					<p class="text-xs text-muted-foreground">
						{editable ? 'Nothing yet — add an item.' : 'Nothing bound yet. Use “Bind data…” to pick a source.'}
					</p>
				{:else}
					<div class="flex flex-wrap gap-1" data-testid="schema-live-fields">
						{#each liveFields as f (f)}
							<Badge variant="secondary" class="font-mono text-xs">{f}</Badge>
						{:else}
							<p class="text-xs text-muted-foreground">No fields — the source returned nothing.</p>
						{/each}
					</div>
					{#if liveSample}
						<pre class="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs" data-testid="schema-live-sample">{liveSample}</pre>
					{/if}
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
