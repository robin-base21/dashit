<script lang="ts">
	import type { ElementRow } from 'shared';
	import TaskTree from './task-tree.svelte';
	import TableEditor from './table-editor.svelte';
	import AggregationView from './aggregation-view.svelte';
	import ChartView from './chart-view.svelte';

	let { element }: { element: ElementRow } = $props();
</script>

{#if element.kind === 'task' || element.kind === 'checklist'}
	<TaskTree elementId={element.id} kind={element.kind} />
{:else if element.kind === 'table'}
	<TableEditor elementId={element.id} />
{:else if element.kind === 'aggregation'}
	<AggregationView {element} />
{:else}
	<ChartView {element} />
{/if}
