<script lang="ts">
	import DashboardGrid from '$lib/components/grid/dashboard-grid.svelte';
	import DragGhost from '$lib/components/grid/drag-ghost.svelte';
	import { getDb } from '$lib/db/context';

	const db = getDb();
</script>

<svelte:head><title>Dashboard · DashIt</title></svelte:head>

<div class="p-4">
	{#if db.info}
		<DashboardGrid dashboardId={db.info.dashboardId} />
	{/if}
</div>
<DragGhost />
