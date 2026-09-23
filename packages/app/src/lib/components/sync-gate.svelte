<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getDb } from '$lib/db/context';
	import { getSession } from '$lib/auth/session.svelte';
	import { getSync } from '$lib/sync/engine.svelte';

	/**
	 * Decides what happens to the local database when an account signs in, then runs sync.
	 *
	 * This lives inside `(app)` because it needs the database; the auth routes deliberately never
	 * open it. Anonymous use is untouched — with no account there is nothing here to do.
	 */
	const db = getDb();
	const session = getSession();
	// Owned by the shell so the context reaches the pages; this only decides when it runs.
	const engine = getSync();

	let running = $state(false);
	let decision = $state<'none' | 'adopt' | 'foreign'>('none');
	let localCount = $state(0);
	let busy = $state(false);

	function run() {
		if (running) return;
		engine.start();
		running = true;
	}

	/** What to do with this database now that an account owns the session. */
	async function decide(accountId: string) {
		const owner = await db.call('getLocalMeta', 'account_id');
		if (owner === accountId) {
			run();
			return;
		}
		if (owner !== null) {
			// It belongs to a different account. §4.8 does not cover switching, so refuse to mix.
			decision = 'foreign';
			return;
		}
		// Never belonged to an account. With nothing in it there is nothing to decide.
		localCount = await db.call('localDataCount');
		if (localCount === 0) {
			await claim(accountId);
			return;
		}
		decision = 'adopt';
	}

	async function claim(accountId: string) {
		await db.call('setLocalMeta', 'account_id', accountId);
		decision = 'none';
		run();
	}

	async function merge(accountId: string) {
		busy = true;
		try {
			// Claiming is all that is needed: the local rows are already pending changes, so the
			// first push carries them up and cr-sqlite unions them by primary key.
			await claim(accountId);
			toast.success('Your dashboard is now synced');
		} finally {
			busy = false;
		}
	}

	async function discard(accountId: string) {
		busy = true;
		try {
			await db.call('discardLocalData');
			await claim(accountId);
			toast('Local data discarded');
		} finally {
			busy = false;
		}
	}

	// Signing in is asynchronous (the session restores from IndexedDB, then verifies), so this
	// reacts to the account arriving rather than running once at mount.
	$effect(() => {
		const id = session.account?.id ?? null;
		if (id === null) {
			if (running) {
				engine.stop();
				running = false;
			}
			return;
		}
		if (running || decision !== 'none') return;
		void decide(id);
	});

</script>

<Dialog.Root open={decision !== 'none'}>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		{#if decision === 'adopt'}
			<Dialog.Header>
				<Dialog.Title>You have a dashboard on this device</Dialog.Title>
				<Dialog.Description>
					It was created before you signed in. Merging keeps it and syncs it to your account.
				</Dialog.Description>
			</Dialog.Header>
			<p class="text-sm text-muted-foreground">
				{localCount}
				{localCount === 1 ? 'element' : 'elements'} would be merged into
				<span class="font-medium text-foreground">{session.account?.email}</span>.
			</p>
			<Dialog.Footer>
				<Button variant="outline" disabled={busy} onclick={() => discard(session.account!.id)}>Discard it</Button>
				<Button disabled={busy} onclick={() => merge(session.account!.id)} data-testid="merge-local">
					{busy ? 'Merging…' : 'Merge into my account'}
				</Button>
			</Dialog.Footer>
		{:else if decision === 'foreign'}
			<Dialog.Header>
				<Dialog.Title>This device belongs to another account</Dialog.Title>
				<Dialog.Description>
					Its data was synced to a different account, so the two cannot be mixed safely.
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => session.signOut()}>Sign out</Button>
				<Button variant="destructive" disabled={busy} onclick={() => discard(session.account!.id)}>
					Discard local data
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
