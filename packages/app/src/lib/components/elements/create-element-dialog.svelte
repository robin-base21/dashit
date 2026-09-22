<script lang="ts">
	import type { ElementKind } from 'shared';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { getDb } from '$lib/db/context';
	import { getUi } from '$lib/state/ui.svelte';
	import { KINDS } from '$lib/elements/kinds';

	const db = getDb();
	const ui = getUi();

	let kind = $state<ElementKind>('checklist');
	let title = $state('');
	let saving = $state(false);

	const selected = $derived(KINDS.find((k) => k.kind === kind)!);

	async function create() {
		saving = true;
		try {
			await db.call('createElement', { kind, title: title.trim() || selected.label });
			toast.success(`${selected.label} created`, { description: 'Find it under Elements → Unplaced.' });
			ui.createDialogOpen = false;
			ui.openElementsPanel('unplaced');
			title = '';
		} catch (e) {
			toast.error('Could not create element', { description: e instanceof Error ? e.message : String(e) });
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open={ui.createDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New element</Dialog.Title>
			<Dialog.Description>Pick a type. You can place it on the dashboard afterwards.</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Element type">
				{#each KINDS as k (k.kind)}
					<button
						type="button"
						role="radio"
						aria-checked={kind === k.kind}
						class={[
							'flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors hover:bg-accent',
							kind === k.kind && 'border-primary bg-accent'
						]}
						onclick={() => (kind = k.kind)}
					>
						<span class="flex items-center gap-2 font-medium">
							<k.icon class="size-4" />
							{k.label}
						</span>
						<span class="text-xs text-muted-foreground">{k.description}</span>
					</button>
				{/each}
			</div>

			<div class="grid gap-2">
				<Label for="element-title">Title</Label>
				<Input
					id="element-title"
					bind:value={title}
					placeholder={selected.label}
					onkeydown={(e) => e.key === 'Enter' && !saving && create()}
				/>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (ui.createDialogOpen = false)}>Cancel</Button>
			<Button onclick={create} disabled={saving}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
