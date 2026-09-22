<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { downloadExport, importFromFile } from '$lib/storage/backup';
	import { formatBytes, readStorageInfo, requestPersistence, type StorageInfo } from '$lib/storage/status.svelte';
	import { getTheme, type ThemePreference } from '$lib/theme/theme.svelte';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	const db = getDb();
	const theme = getTheme();

	const THEMES: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
		{ value: 'light', label: 'Light', icon: SunIcon },
		{ value: 'dark', label: 'Dark', icon: MoonIcon },
		{ value: 'system', label: 'System', icon: MonitorIcon }
	];

	let storage = $state<StorageInfo | null>(null);
	void readStorageInfo().then((s) => (storage = s));

	const lastExport = liveQuery(db, (d) => d.call('getLocalMeta', 'last_export_at'), ['local_meta']);
	const elementCount = liveQuery(db, async (d) => (await d.call('listElements')).length, ['elements']);

	let fileInput = $state<HTMLInputElement | null>(null);
	let importing = $state(false);

	async function persist() {
		const ok = await requestPersistence();
		storage = await readStorageInfo();
		toast(ok ? 'Storage marked persistent' : 'The browser declined persistent storage');
	}

	async function onImport(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		importing = true;
		try {
			const summary = await importFromFile(db, file);
			toast.success(`Imported ${summary.rows} rows`, { description: 'Existing rows with the same id were updated.' });
		} catch (err) {
			toast.error('Import failed', { description: err instanceof Error ? err.message : String(err) });
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	const lastExportLabel = $derived(lastExport.value ? new Date(Number(lastExport.value)).toLocaleString() : 'never');
</script>

<svelte:head><title>Settings · DashIt</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<div>
		<h1 class="text-lg font-semibold">Settings</h1>
		<p class="text-sm text-muted-foreground">Storage, backups and account.</p>
	</div>

	{#if (elementCount.value ?? 0) > 0}
		<Alert.Root data-testid="eviction-banner">
			<TriangleAlertIcon class="size-4" />
			<Alert.Title>Your data lives only in this browser</Alert.Title>
			<Alert.Description>
				There is no account yet, so nothing is backed up or synced. Browser storage can be cleared by the browser
				or by you. Export a backup regularly (last export: {lastExportLabel}).
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Appearance</Card.Title>
			<Card.Description>Theme for this browser. “System” follows your operating system.</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Theme">
				{#each THEMES as t (t.value)}
					<button
						type="button"
						role="radio"
						aria-checked={theme.preference === t.value}
						class={[
							'flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm transition-colors',
							theme.preference === t.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
						]}
						onclick={() => theme.set(t.value)}
					>
						<t.icon class="size-4" />
						{t.label}
					</button>
				{/each}
			</div>
			<p class="mt-2 text-xs text-muted-foreground">Currently showing the {theme.resolved} theme.</p>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Backup</Card.Title>
			<Card.Description>Plaintext JSON of everything on your dashboard. Import merges by id.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-wrap gap-2">
			<Button onclick={() => downloadExport(db)} data-testid="export">
				<DownloadIcon class="size-4" />
				Export JSON
			</Button>
			<Button variant="outline" onclick={() => fileInput?.click()} disabled={importing}>
				<UploadIcon class="size-4" />
				Import JSON
			</Button>
			<input bind:this={fileInput} type="file" accept="application/json,.json" class="hidden" onchange={onImport} data-testid="import-input" />
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Local storage</Card.Title>
			<Card.Description>Where your database lives on this device.</Card.Description>
		</Card.Header>
		<Card.Content>
			<dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
				<dt class="text-muted-foreground">Engine</dt>
				<dd>SQLite (cr-sqlite) via <Badge variant="secondary">{db.info?.vfs === 'opfs-ahp' ? 'OPFS' : db.info?.vfs === 'idb' ? 'IndexedDB' : db.info?.vfs}</Badge></dd>
				<dt class="text-muted-foreground">Persistent</dt>
				<dd class="flex items-center gap-2">
					{storage?.persisted === null ? 'unknown' : storage?.persisted ? 'yes' : 'no'}
					{#if storage?.persisted === false}
						<Button size="xs" variant="outline" onclick={persist}>Request</Button>
					{/if}
				</dd>
				<dt class="text-muted-foreground">Usage</dt>
				<dd>{formatBytes(storage?.usageBytes ?? null)} of {formatBytes(storage?.quotaBytes ?? null)}</dd>
				<dt class="text-muted-foreground">Schema</dt>
				<dd>v{db.info?.schemaVersion}</dd>
				<dt class="text-muted-foreground">Site id</dt>
				<dd class="font-mono text-xs">{db.info?.siteId}</dd>
			</dl>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Account</Card.Title>
			<Card.Description>Anonymous mode.</Card.Description>
		</Card.Header>
		<Card.Content class="text-sm text-muted-foreground">
			<p>
				You are using DashIt without an account. Everything works locally. Accounts add encrypted sync between your
				devices and a recovery key; until then, datasource credentials and API keys entered here are stored
				unencrypted on this device.
			</p>
		</Card.Content>
	</Card.Root>
</div>
