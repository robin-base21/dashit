<script lang="ts">
	import type { ElementRow } from 'shared';
	import { Button } from '$lib/components/ui/button';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { keyValueRows, parseKeyValueConfig } from '$lib/elements/keyvalue-config';
	import BindDataDialog from './bind-data-dialog.svelte';
	import LinkIcon from '@lucide/svelte/icons/link';

	let { element }: { element: ElementRow } = $props();

	const dataflow = getDataflow();
	const config = $derived(parseKeyValueConfig(element.config_json));
	const bound = $derived(dataflow.datasetOf(element.id));
	const rows = $derived(bound.state.status === 'ok' ? keyValueRows(bound.state.value, config) : []);

	// Several records with no fields chosen cannot be laid out without guessing, so ask instead.
	const needsFields = $derived(
		bound.state.status === 'ok' && rows.length === 0 && !(config.label && config.value)
	);

	let bindOpen = $state(false);
</script>

<div class="flex h-full flex-col p-1" data-testid="keyvalue">
	{#if bound.state.status === 'unbound'}
		<div class="m-auto flex flex-col items-center gap-1 text-center">
			<p class="text-xs text-muted-foreground">Not bound to any data.</p>
			<Button size="xs" variant="outline" onclick={() => (bindOpen = true)}>
				<LinkIcon class="size-3.5" />
				Bind data
			</Button>
		</div>
	{:else if bound.state.status === 'error'}
		<p class="m-auto text-xs text-destructive" title={bound.state.error ?? ''}>Error in source</p>
	{:else if needsFields}
		<div class="m-auto flex flex-col items-center gap-1 text-center">
			<p class="text-xs text-muted-foreground">Pick the label and value fields.</p>
			<Button size="xs" variant="outline" onclick={() => (bindOpen = true)}>Configure</Button>
		</div>
	{:else if rows.length === 0}
		<p class="m-auto text-xs text-muted-foreground">No data yet.</p>
	{:else}
		<dl class="flex flex-col divide-y overflow-auto text-sm" data-testid="keyvalue-rows">
			{#each rows as row (row.key)}
				<div class="flex items-baseline justify-between gap-3 px-2 py-1.5" data-kv-key={row.key}>
					<dt class="min-w-0 truncate text-muted-foreground" title={row.key}>{row.key}</dt>
					<dd class="shrink-0 font-medium tabular-nums" title={row.title ?? row.display}>{row.display}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</div>

<BindDataDialog {element} bind:open={bindOpen} />
