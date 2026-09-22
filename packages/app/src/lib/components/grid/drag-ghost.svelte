<script lang="ts">
	import { getUi } from '$lib/state/ui.svelte';

	const ui = getUi();
	const ghost = $derived(ui.drag?.kind === 'place' && ui.drag.started ? ui.drag : null);
</script>

{#if ghost}
	<div
		class="pointer-events-none fixed z-50 rounded-md border bg-card px-3 py-1.5 text-sm shadow-lg"
		style:left="{ghost.x + 12}px"
		style:top="{ghost.y + 12}px"
		aria-hidden="true"
	>
		{ghost.label}
	</div>
{/if}
