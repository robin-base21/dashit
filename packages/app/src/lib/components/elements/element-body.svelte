<script lang="ts">
	import type { ElementRow } from 'shared';
	import TaskTree from './task-tree.svelte';
	import TableEditor from './table-editor.svelte';
	import AggregationView from './aggregation-view.svelte';
	import ChartView from './chart-view.svelte';
	import ProgressView from './progress-view.svelte';
	import KeyValueView from './keyvalue-view.svelte';

	let { element }: { element: ElementRow } = $props();
</script>

{#if element.kind === 'task'}
	<TaskTree elementId={element.id} />
{:else if element.kind === 'table'}
	<TableEditor elementId={element.id} />
{:else if element.kind === 'aggregation'}
	<AggregationView {element} />
{:else if element.kind === 'progress'}
	<ProgressView {element} />
{:else if element.kind === 'keyvalue'}
	<KeyValueView {element} />
{:else if element.kind === 'chart'}
	<ChartView {element} />
{:else}
	<!-- Every kind is listed above on purpose: a bare `else` would quietly render the next kind
	     someone adds as a chart instead of showing that nothing handles it yet. -->
	<p class="m-auto p-3 text-center text-xs text-muted-foreground">
		Nothing can display a “{element.kind}” element.
	</p>
{/if}
