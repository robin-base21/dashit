<script lang="ts">
	import { aggregate, type ElementRow } from 'shared';
	import { Button } from '$lib/components/ui/button';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { formatNumber, parseAggregationConfig } from '$lib/elements/config';
	import BindDataDialog from './bind-data-dialog.svelte';
	import LinkIcon from '@lucide/svelte/icons/link';

	let { element }: { element: ElementRow } = $props();

	const dataflow = getDataflow();
	const config = $derived(parseAggregationConfig(element.config_json));
	const bound = $derived(dataflow.datasetOf(element.id));
	const result = $derived(bound.state.status === 'ok' ? aggregate(bound.state.value, config) : null);

	const label = $derived(
		config.field ? `${config.fn} of ${config.field}` : config.fn === 'count' ? 'count' : `${config.fn}`
	);

	let bindOpen = $state(false);
</script>

<div class="flex h-full flex-col items-center justify-center gap-1 p-3 text-center" data-testid="aggregation">
	{#if bound.state.status === 'unbound'}
		<p class="text-xs text-muted-foreground">Not bound to any data.</p>
		<Button size="xs" variant="outline" onclick={() => (bindOpen = true)}>
			<LinkIcon class="size-3.5" />
			Bind data
		</Button>
	{:else if bound.state.status === 'error'}
		<p class="text-xs text-destructive" title={bound.state.error ?? ''}>Error in source</p>
	{:else}
		<div class="text-3xl font-semibold tabular-nums" data-testid="aggregation-value">
			{result === null ? '—' : formatNumber(result)}
		</div>
		<button type="button" class="text-xs text-muted-foreground hover:underline" onclick={() => (bindOpen = true)}>
			{label}
		</button>
	{/if}
</div>

<BindDataDialog {element} bind:open={bindOpen} />
