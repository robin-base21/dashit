<script lang="ts">
	import type { ElementRow } from 'shared';
	import { KIND_META } from '$lib/elements/kinds';
	import TaskTree from './task-tree.svelte';
	import TableEditor from './table-editor.svelte';
	import AggregationView from './aggregation-view.svelte';

	let { element }: { element: ElementRow } = $props();
	const meta = $derived(KIND_META[element.kind]);
</script>

{#if element.kind === 'task' || element.kind === 'checklist'}
	<TaskTree elementId={element.id} kind={element.kind} />
{:else if element.kind === 'table'}
	<TableEditor elementId={element.id} />
{:else if element.kind === 'aggregation'}
	<AggregationView {element} />
{:else}
	<!-- Charts land in Phase 1.5. -->
	<div class="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
		<div class="flex flex-col items-center gap-1">
			<meta.icon class="size-5" />
			<span>{meta.label}</span>
		</div>
	</div>
{/if}
