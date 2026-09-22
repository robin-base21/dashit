<script lang="ts">
	import type { ElementRow } from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getDb } from '$lib/db/context';
	import { KIND_META } from '$lib/elements/kinds';
	import ElementBody from './element-body.svelte';
	import BindDataDialog from './bind-data-dialog.svelte';
	import LinkIcon from '@lucide/svelte/icons/link';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import PanelRightOpenIcon from '@lucide/svelte/icons/panel-right-open';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	let {
		element,
		dragging = false,
		onmovestart,
		onresizestart
	}: {
		element: ElementRow;
		dragging?: boolean;
		onmovestart: (e: PointerEvent) => void;
		onresizestart: (e: PointerEvent) => void;
	} = $props();

	const db = getDb();
	const meta = $derived(KIND_META[element.kind]);

	let editingTitle = $state(false);
	let draftTitle = $state('');
	let bindOpen = $state(false);
	const observable = $derived(meta.category === 'observable');

	function startEdit() {
		draftTitle = element.title;
		editingTitle = true;
	}

	async function commitTitle() {
		editingTitle = false;
		const title = draftTitle.trim();
		if (title && title !== element.title) await db.call('updateElement', element.id, { title });
	}

	async function hide() {
		await db.call('setPlacementHidden', element.id, true);
		toast(`Hid “${element.title || meta.label}”`, { description: 'Find it under Elements → Hidden.' });
	}

	async function unplace() {
		await db.call('unplaceElement', element.id);
	}

	async function remove() {
		await db.call('deleteElement', element.id);
		toast(`Deleted “${element.title || meta.label}”`);
	}
</script>

<article
	class={[
		'relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs',
		dragging && 'opacity-60 ring-2 ring-primary'
	]}
	data-element-id={element.id}
	data-kind={element.kind}
>
	<header class="flex items-center gap-1 border-b px-2 py-1">
		<button
			type="button"
			class="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
			aria-label="Move"
			onpointerdown={onmovestart}
		>
			<GripVerticalIcon class="size-4" />
		</button>
		<meta.icon class="size-3.5 shrink-0 text-muted-foreground" />
		{#if editingTitle}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="min-w-0 flex-1 rounded border-none bg-transparent px-1 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
				bind:value={draftTitle}
				autofocus
				onblur={commitTitle}
				onkeydown={(e) => {
					if (e.key === 'Enter') commitTitle();
					if (e.key === 'Escape') editingTitle = false;
				}}
			/>
		{:else}
			<button
				type="button"
				class="min-w-0 flex-1 truncate px-1 text-left text-sm font-medium hover:underline"
				ondblclick={startEdit}
				title="Double-click to rename"
			>
				{element.title || meta.label}
			</button>
		{/if}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="icon-xs" variant="ghost" aria-label="Element actions">
						<EllipsisIcon class="size-4" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Item onclick={startEdit}>Rename</DropdownMenu.Item>
				{#if observable}
					<DropdownMenu.Item onclick={() => (bindOpen = true)}>
						<LinkIcon class="size-4" />
						Bind data…
					</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Item onclick={hide}>
					<EyeOffIcon class="size-4" />
					Hide
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={unplace}>
					<PanelRightOpenIcon class="size-4" />
					Remove from dashboard
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onclick={remove}>
					<Trash2Icon class="size-4" />
					Delete
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<ElementBody {element} />
	</div>

	{#if observable}
		<BindDataDialog {element} bind:open={bindOpen} />
	{/if}

	<button
		type="button"
		class="absolute right-0 bottom-0 size-4 cursor-se-resize touch-none text-muted-foreground/60 hover:text-foreground"
		aria-label="Resize"
		onpointerdown={onresizestart}
	>
		<svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
			<path d="M14 2 2 14M14 8l-6 6M14 14h0" stroke="currentColor" stroke-width="1.5" fill="none" />
		</svg>
	</button>
</article>
