<script lang="ts">
	import type { ElementRow } from 'shared';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { parseProgressConfig, progressValues } from '$lib/elements/progress-config';
	import BindDataDialog from './bind-data-dialog.svelte';
	import LinkIcon from '@lucide/svelte/icons/link';

	let { element }: { element: ElementRow } = $props();

	const dataflow = getDataflow();
	const config = $derived(parseProgressConfig(element.config_json));
	const bound = $derived(dataflow.datasetOf(element.id));
	const result = $derived(
		bound.state.status === 'ok' ? progressValues(bound.state.value, config) : null
	);

	const label = $derived.by(() => {
		const n = config.value.field ? `${config.value.fn} of ${config.value.field}` : config.value.fn;
		const m =
			typeof config.total === 'number'
				? String(config.total)
				: config.total.field
					? `${config.total.fn} of ${config.total.field}`
					: config.total.fn;
		return `${n} / ${m}`;
	});

	let bindOpen = $state(false);
</script>

<div class="flex h-full flex-col justify-center gap-2 p-3" data-testid="progress">
	{#if bound.state.status === 'unbound'}
		<div class="flex flex-col items-center gap-1 text-center">
			<p class="text-xs text-muted-foreground">Not bound to any data.</p>
			<Button size="xs" variant="outline" onclick={() => (bindOpen = true)}>
				<LinkIcon class="size-3.5" />
				Bind data
			</Button>
		</div>
	{:else if bound.state.status === 'error'}
		<p class="m-auto text-xs text-destructive" title={bound.state.error ?? ''}>Error in source</p>
	{:else}
		<div class="text-2xl font-semibold tabular-nums" data-testid="progress-value">
			{result?.label ?? '—'}
		</div>
		<Progress value={(result?.fraction ?? 0) * 100} max={100} />
		<button
			type="button"
			class="truncate text-left text-xs text-muted-foreground hover:underline"
			onclick={() => (bindOpen = true)}
		>
			{label}
		</button>
	{/if}
</div>

<BindDataDialog {element} bind:open={bindOpen} />
