<script lang="ts">
	import type { TaskItemRow } from 'shared';
	import type { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Button } from '$lib/components/ui/button';
	import { getDb } from '$lib/db/context';
	import Self from './task-tree-node.svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	let {
		item,
		children,
		collapsed,
		defaultCollapsed,
		depth
	}: {
		item: TaskItemRow;
		children: Map<string, TaskItemRow[]>;
		collapsed: SvelteSet<string>;
		defaultCollapsed: boolean;
		depth: number;
	} = $props();

	const db = getDb();

	const kids = $derived(children.get(item.id) ?? []);
	// Membership in `collapsed` toggles away from the default for this element kind.
	const isOpen = $derived(kids.length > 0 && (defaultCollapsed ? collapsed.has(item.id) : !collapsed.has(item.id)));

	let editing = $state(false);
	let draft = $state('');
	let addingChild = $state(false);
	let childDraft = $state('');
	let childInput = $state<HTMLInputElement | null>(null);

	function toggle() {
		if (collapsed.has(item.id)) collapsed.delete(item.id);
		else collapsed.add(item.id);
	}

	function startEdit() {
		draft = item.title;
		editing = true;
	}

	async function commitEdit() {
		if (!editing) return;
		editing = false;
		const title = draft.trim();
		if (title && title !== item.title) await db.call('updateTaskItem', item.id, { title });
	}

	async function setDone(done: boolean) {
		await db.call('updateTaskItem', item.id, { done });
	}

	async function startAddChild() {
		addingChild = true;
		// Make sure the parent is expanded so the new child is visible.
		if (!isOpen && kids.length > 0) toggle();
		await tick();
		childInput?.focus();
	}

	async function commitChild() {
		const title = childDraft.trim();
		if (!title) {
			addingChild = false;
			return;
		}
		childDraft = '';
		if (defaultCollapsed && !collapsed.has(item.id)) collapsed.add(item.id);
		await db.call('addTaskItem', { element_id: item.element_id, title, parent_id: item.id });
	}

	async function remove() {
		await db.call('deleteTaskItem', item.id);
	}
</script>

<li role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected="false" data-item-id={item.id}>
	<div class="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/60" style:padding-left="{depth * 16 + 4}px">
		<button
			type="button"
			class={['size-4 shrink-0 rounded text-muted-foreground', kids.length === 0 && 'invisible']}
			aria-label={isOpen ? 'Collapse' : 'Expand'}
			tabindex={kids.length ? 0 : -1}
			onclick={toggle}
		>
			<ChevronRightIcon class={['size-4 transition-transform', isOpen && 'rotate-90']} />
		</button>
		<Checkbox checked={item.done === 1} onCheckedChange={(v) => setDone(v === true)} aria-label="Done" />
		{#if editing}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="min-w-0 flex-1 rounded bg-transparent px-1 outline-none focus:ring-1 focus:ring-ring"
				bind:value={draft}
				autofocus
				onblur={commitEdit}
				onkeydown={(e) => {
					if (e.key === 'Enter') commitEdit();
					if (e.key === 'Escape') editing = false;
				}}
			/>
		{:else}
			<button
				type="button"
				class={['min-w-0 flex-1 truncate px-1 text-left', item.done === 1 && 'text-muted-foreground line-through']}
				onclick={startEdit}
				title="Click to edit"
			>
				{item.title}
			</button>
		{/if}
		<div class="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
			<Button size="icon-xs" variant="ghost" aria-label="Add sub-task" onclick={startAddChild}>
				<PlusIcon class="size-3.5" />
			</Button>
			<Button size="icon-xs" variant="ghost" aria-label="Delete item" onclick={remove}>
				<Trash2Icon class="size-3.5" />
			</Button>
		</div>
	</div>

	{#if isOpen || addingChild}
		<ul role="group" class="space-y-0.5">
			{#if isOpen}
				{#each kids as kid (kid.id)}
					<Self item={kid} {children} {collapsed} {defaultCollapsed} depth={depth + 1} />
				{/each}
			{/if}
			{#if addingChild}
				<li class="flex items-center gap-1 px-1 py-0.5" style:padding-left="{(depth + 1) * 16 + 24}px">
					<input
						bind:this={childInput}
						class="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
						placeholder="Sub-task…"
						bind:value={childDraft}
						onkeydown={(e) => {
							if (e.key === 'Enter') commitChild();
							if (e.key === 'Escape') addingChild = false;
						}}
						onblur={() => {
							if (!childDraft.trim()) addingChild = false;
						}}
						aria-label="New sub-task"
					/>
				</li>
			{/if}
		</ul>
	{/if}
</li>
