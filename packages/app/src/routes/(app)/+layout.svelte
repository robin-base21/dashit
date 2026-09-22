<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { Toaster } from '$lib/components/ui/sonner';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import ElementsPanel from '$lib/components/elements/elements-panel.svelte';
	import { onDestroy } from 'svelte';
	import { Db } from '$lib/db/client.svelte';
	import { setDb } from '$lib/db/context';
	import { UiState, setUi } from '$lib/state/ui.svelte';
	import { Dataflow, setDataflow } from '$lib/dataflow/engine.svelte';
	import { DatasourceRuntime, setRuntime } from '$lib/dataflow/runtime-context';
	import { runEvictionCheck } from '$lib/storage/status.svelte';
	import { downloadExport } from '$lib/storage/backup';
	import { Button } from '$lib/components/ui/button';

	let { children } = $props();

	// One tab owns the database at a time (ARCHITECTURE.md §10, multi-tab deferred). The lock is
	// held for the lifetime of the tab; a second tab sees `ifAvailable` fail and stays read-only.
	const tabLock = new Promise<boolean>((resolve) => {
		if (!navigator.locks) return resolve(true);
		void navigator.locks.request('dashit-db', { ifAvailable: true }, (lock) => {
			resolve(lock !== null);
			return lock ? new Promise<void>(() => {}) : undefined;
		});
	});

	const db = new Db();
	setDb(db);
	setUi(new UiState());

	const dataflow = new Dataflow(db);
	setDataflow(dataflow);
	const runtime = new DatasourceRuntime(db);
	setRuntime(runtime);
	dataflow.externalRuntime = runtime;

	const boot = tabLock.then(async (owns) => {
		if (!owns) return false;
		await db.open();
		runtime.start();
		dataflow.start();
		void runEvictionCheck(db, () => downloadExport(db));
		return true;
	});
	onDestroy(() => {
		dataflow.stop();
		runtime.stop();
	});
</script>

{#await boot}
	<div class="flex h-svh items-center justify-center text-sm text-muted-foreground">Opening local database…</div>
{:then ownsLock}
	{#if !ownsLock}
		<div class="m-8 rounded-md border p-6 text-sm">
			<p class="font-medium">DashIt is already open in another tab.</p>
			<p class="mt-1 text-muted-foreground">Only one tab can write to the local database at a time. Close the other tab, then reload this one.</p>
			<Button class="mt-4" variant="outline" onclick={() => location.reload()}>Reload</Button>
		</div>
	{:else}
	<Sidebar.Provider open={false}>
		<AppSidebar />
		<Sidebar.Inset>
			{@render children()}
		</Sidebar.Inset>
		<ElementsPanel />
	</Sidebar.Provider>
	{/if}
{:catch error}
	<div class="m-8 rounded-md border border-destructive p-4 text-sm">
		<p class="font-medium">The local database could not be opened.</p>
		<pre class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{error.message}</pre>
	</div>
{/await}

<Toaster />
