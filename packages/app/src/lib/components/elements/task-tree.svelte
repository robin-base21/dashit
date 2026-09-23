<script lang="ts">
	import type { TaskItemRow } from 'shared';
	import { SvelteSet } from 'svelte/reactivity';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Button } from '$lib/components/ui/button';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import TaskTreeNode from './task-tree-node.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let { elementId }: { elementId: string } = $props();

	const db = getDb();
	const items = liveQuery(db, (d) => d.call('listTaskItems', elementId), ['task_items']);

	/** parent id (or 'root') → ordered children */
	const children = $derived.by(() => {
		const map = new Map<string, TaskItemRow[]>();
		for (const it of items.value ?? []) {
			const key = it.parent_id ?? 'root';
			const arr = map.get(key) ?? [];
			arr.push(it);
			map.set(key, arr);
		}
		return map;
	});

	/** Item ids the user has collapsed; sub-tasks are shown by default. */
	const collapsed = new SvelteSet<string>();

	let draft = $state('');
	let adding = $state(false);

	async function addRoot() {
		const title = draft.trim();
		if (!title) return;
		draft = '';
		await db.call('addTaskItem', { element_id: elementId, title });
	}

	const done = $derived((items.value ?? []).filter((i) => i.done).length);
	const total = $derived((items.value ?? []).length);
</script>

<div class="flex h-full flex-col text-sm">
	<ul class="flex-1 space-y-0.5 p-2" role="tree" aria-label="Items">
		{#each children.get('root') ?? [] as item (item.id)}
			<TaskTreeNode {item} {children} {collapsed} depth={0} />
		{:else}
			{#if !adding}
				<li class="px-2 py-3 text-center text-xs text-muted-foreground">No items yet.</li>
			{/if}
		{/each}
	</ul>

	<div class="flex items-center gap-1 border-t px-2 py-1">
		<Checkbox class="invisible" aria-hidden="true" tabindex={-1} />
		<input
			class="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
			placeholder="Add a task…"
			bind:value={draft}
			onfocus={() => (adding = true)}
			onblur={() => (adding = false)}
			onkeydown={(e) => e.key === 'Enter' && addRoot()}
			aria-label="New item"
		/>
		<Button size="icon-xs" variant="ghost" aria-label="Add item" onclick={addRoot} disabled={!draft.trim()}>
			<PlusIcon class="size-3.5" />
		</Button>
		{#if total > 0}
			<span class="ml-1 text-xs tabular-nums text-muted-foreground">{done}/{total}</span>
		{/if}
	</div>
</div>
