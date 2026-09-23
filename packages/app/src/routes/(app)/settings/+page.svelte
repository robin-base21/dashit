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
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { goto } from '$app/navigation';
	import { RelayError } from '$lib/auth/api';
	import { getSession } from '$lib/auth/session.svelte';
	import { getSync } from '$lib/sync/engine.svelte';
	import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
	import { enrolAnotherPasskey } from '$lib/auth/flows';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import PlusIcon from '@lucide/svelte/icons/plus';

	const db = getDb();
	const theme = getTheme();
	const session = getSession();
	const sync = getSync();

	const SYNC_LABEL: Record<string, string> = {
		off: 'Not syncing',
		idle: 'Up to date',
		syncing: 'Syncing…',
		error: 'Could not sync',
		update_required: 'Update required'
	};

	function agoLabel(at: number): string {
		const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
		if (secs < 60) return 'just now';
		if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
		return new Date(at).toLocaleString();
	}

	let renaming = $state<string | null>(null);
	let draftLabel = $state('');

	// Adding a passkey is what turns "signed in on a new device" into "this device is set up".
	type EnrolStep = 'idle' | 'code' | 'creating';
	let enrolStep = $state<EnrolStep>('idle');
	let enrolCode = $state('');
	let enrolBusy = $state(false);

	async function startEnrol() {
		enrolBusy = true;
		try {
			await session.client.post('/auth/enroll/start');
			enrolStep = 'code';
			enrolCode = '';
		} catch (e) {
			toast.error('Could not send a code', { description: explain(e) });
		} finally {
			enrolBusy = false;
		}
	}

	async function finishEnrol() {
		enrolBusy = true;
		try {
			await enrolAnotherPasskey(session.client, enrolCode.trim());
			await session.loadCredentials();
			enrolStep = 'idle';
			toast.success('Passkey added');
		} catch (e) {
			toast.error('Could not add the passkey', { description: explain(e) });
		} finally {
			enrolBusy = false;
		}
	}

	function explain(e: unknown): string {
		// A second passkey cannot live on an authenticator that already holds one — `excludeCredentials`
		// sees to that — and the browser's own wording for it is unreadable.
		if (e instanceof DOMException && e.name === 'InvalidStateError') {
			return 'This device already has a passkey for DashIt. Add one on another device, or use a security key.';
		}
		if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
			return 'Passkey setup was cancelled.';
		}
		if (e instanceof RelayError) {
			if (e.code === 'last_unlock_method') return 'That is your only passkey. Add another before removing it.';
			if (e.code === 'invalid_code') return 'That code is not right, or it has expired.';
			if (e.code === 'locked') return 'Too many wrong codes. Try again in an hour.';
			if (e.code === 'recent_auth_required') return 'Sign in again before changing your passkeys.';
			if (e.rateLimited) return 'Too many attempts. Try again shortly.';
		}
		return e instanceof Error ? e.message : String(e);
	}

	async function renameCredential(id: string) {
		try {
			await session.client.call(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ label: draftLabel.trim() }) });
			await session.loadCredentials();
			renaming = null;
		} catch (e) {
			toast.error('Could not rename', { description: explain(e) });
		}
	}

	async function removeCredential(id: string) {
		try {
			await session.client.call(`/keys/${id}`, { method: 'DELETE' });
		} catch (e) {
			toast.error('Could not remove', { description: explain(e) });
			return;
		}
		try {
			await session.loadCredentials();
			toast('Passkey removed');
		} catch {
			// Deleting a credential revokes its sessions (§4.5), and the one signing you in on this
			// device is one of them. Say so, rather than leaving a stale list above a dead session.
			await session.signOutLocally();
			toast('Passkey removed — you were signed out', {
				description: 'That passkey was signing you in here. Sign in again with another one.'
			});
		}
	}

	async function deleteAccount() {
		try {
			await session.client.call('/account', { method: 'DELETE' });
			await session.signOutLocally();
			toast('Account deleted', { description: 'Your local data is untouched and still works.' });
		} catch (e) {
			toast.error('Could not delete the account', { description: explain(e) });
		}
	}

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

	<Card.Root data-testid="account-card">
		<Card.Header>
			<Card.Title>Account</Card.Title>
			<Card.Description>
				{session.signedIn ? session.account?.email : 'Anonymous mode.'}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4 text-sm">
			{#if session.deleted}
				<Alert.Root variant="destructive">
					<TriangleAlertIcon />
					<Alert.Title>This account was deleted</Alert.Title>
					<Alert.Description>
						It is gone from the relay. Your local data is untouched and still works.
					</Alert.Description>
					<Alert.Action>
						<Button size="sm" variant="outline" onclick={() => session.signOutLocally()}>Sign out</Button>
					</Alert.Action>
				</Alert.Root>
			{:else if !session.signedIn}
				<p class="text-muted-foreground">
					You are using DashIt without an account. Everything works locally. An account adds sync between your
					devices; until then, datasource credentials and API keys entered here are stored unencrypted on this
					device.
				</p>
				<div class="flex gap-2">
					<Button size="sm" onclick={() => goto('/register')}>Create an account</Button>
					<Button size="sm" variant="outline" onclick={() => goto('/login')}>Sign in</Button>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Passkeys</h3>
					<ul class="flex flex-col gap-2" data-testid="credential-list">
						{#each session.credentials as cred (cred.id)}
							<li class="flex items-center gap-2 rounded-md border p-2" data-credential-id={cred.id}>
								<KeyRoundIcon class="size-4 shrink-0 text-muted-foreground" />
								{#if renaming === cred.id}
									<!-- svelte-ignore a11y_autofocus -->
									<input
										class="min-w-0 flex-1 rounded bg-transparent px-1 outline-none focus:ring-1 focus:ring-ring"
										bind:value={draftLabel}
										autofocus
										onblur={() => renameCredential(cred.id)}
										onkeydown={(e) => {
											if (e.key === 'Enter') renameCredential(cred.id);
											if (e.key === 'Escape') renaming = null;
										}}
										aria-label="Passkey name"
									/>
								{:else}
									<button
										type="button"
										class="min-w-0 flex-1 truncate text-left hover:underline"
										onclick={() => {
											renaming = cred.id;
											draftLabel = cred.label;
										}}
									>
										{cred.label}
									</button>
								{/if}
								{#if !cred.prf_capable}
									<Badge variant="outline">no encryption support</Badge>
								{/if}
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label="Remove passkey"
									onclick={() => removeCredential(cred.id)}
								>
									<Trash2Icon class="size-4" />
								</Button>
							</li>
						{:else}
							<li class="text-xs text-muted-foreground">No passkeys listed.</li>
						{/each}
					</ul>
				</div>
				{#if enrolStep === 'idle'}
					<Button size="sm" variant="outline" class="self-start" onclick={startEnrol} disabled={enrolBusy} data-testid="add-passkey">
						<PlusIcon class="size-4" />
						{enrolBusy ? 'Sending a code…' : 'Add a passkey'}
					</Button>
				{:else}
					<div class="grid gap-2 rounded-md border p-3" data-testid="enrol-panel">
						<Label for="enrol-code">Enter the code we emailed you</Label>
						<Input
							id="enrol-code"
							inputmode="numeric"
							autocomplete="one-time-code"
							placeholder="000000"
							bind:value={enrolCode}
							onkeydown={(e) => e.key === 'Enter' && enrolCode.trim().length === 6 && finishEnrol()}
						/>
						<p class="text-xs text-muted-foreground">
							The new passkey has to live somewhere this device's one does not — another device (choose
							<span class="font-medium">“use a passkey from another device”</span> in the prompt) or a security
							key. Adding one is confirmed by email, so a stolen session cannot quietly add its own.
						</p>
						<div class="flex gap-2">
							<Button
								size="sm"
								onclick={finishEnrol}
								disabled={enrolBusy || enrolCode.trim().length !== 6}
								data-testid="confirm-passkey"
							>
								{enrolBusy ? 'Creating…' : 'Create passkey'}
							</Button>
							<Button size="sm" variant="ghost" onclick={() => (enrolStep = 'idle')}>Cancel</Button>
						</div>
					</div>
				{/if}

				<div class="flex flex-col gap-1 rounded-md border p-3" data-testid="sync-status">
					<div class="flex items-center justify-between gap-2">
						<span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sync</span>
						<Button size="icon-sm" variant="ghost" onclick={() => sync.syncNow()} aria-label="Sync now">
							<RefreshIcon class="size-3.5" />
						</Button>
					</div>
					<p class="text-sm" data-testid="sync-state">{SYNC_LABEL[sync.status] ?? sync.status}</p>
					{#if sync.lastError}
						<p class="text-xs text-destructive">{sync.lastError}</p>
					{:else if sync.lastSyncAt}
						<p class="text-xs text-muted-foreground">Last synced {agoLabel(sync.lastSyncAt)}</p>
					{/if}
				</div>
				<div class="flex gap-2">
					<Button size="sm" variant="outline" onclick={() => session.signOut()}>Sign out</Button>
					<Button size="sm" variant="destructive" onclick={deleteAccount}>Delete account</Button>
				</div>
			{/if}

			{#if session.offline}
				<p class="text-xs text-muted-foreground">
					The relay is unreachable. Everything local keeps working.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
