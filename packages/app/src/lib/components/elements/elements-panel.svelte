<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getUi, type PanelTab } from '$lib/state/ui.svelte';
	import { CATEGORIES, KIND_META } from '$lib/elements/kinds';
	import CreateElementDialog from './create-element-dialog.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';

	const db = getDb();
	const ui = getUi();

	const elements = liveQuery(db, (d) => d.call('listElementsWithPlacement'), ['elements', 'placements']);

	const unplaced = $derived((elements.value ?? []).filter((e) => !e.placed));
	const hidden = $derived((elements.value ?? []).filter((e) => e.placed && e.hidden));
	const list = $derived(ui.panelTab === 'unplaced' ? unplaced : hidden);

	/** Editables and observables stay apart here too, so the panel reads like the create dialog. */
	const groups = $derived(
		CATEGORIES.map((cat) => ({ ...cat, items: list.filter((e) => KIND_META[e.kind].category === cat.category) })).filter(
			(g) => g.items.length > 0
		)
	);

	function startPlace(e: PointerEvent, elementId: string, kind: keyof typeof KIND_META, label: string) {
		if (e.button !== 0) return;
		e.preventDefault();
		const size = KIND_META[kind].defaultSize;
		ui.beginDrag({ kind: 'place', elementId, label, w: size.w, h: size.h, origin: null, startX: e.clientX, startY: e.clientY });
	}

	async function unhide(id: string) {
		await db.call('setPlacementHidden', id, false);
	}

	async function remove(id: string, title: string) {
		await db.call('deleteElement', id);
		toast(`Deleted “${title}”`);
	}
</script>

{#if ui.elementsPanelOpen}
	<aside class="flex w-80 shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground" aria-label="Elements">
		<header class="flex items-center justify-between gap-2 border-b px-3 py-2">
			<h2 class="text-sm font-semibold">Elements</h2>
			<div class="flex items-center gap-1">
				<Button size="sm" onclick={() => (ui.createDialogOpen = true)}>
					<PlusIcon class="size-4" />
					New
				</Button>
				<Button size="icon-sm" variant="ghost" aria-label="Close panel" onclick={() => (ui.elementsPanelOpen = false)}>
					<XIcon class="size-4" />
				</Button>
			</div>
		</header>

		<Tabs.Root value={ui.panelTab} onValueChange={(v) => (ui.panelTab = v as PanelTab)} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List class="mx-3 mt-2 grid grid-cols-2">
				<Tabs.Trigger value="unplaced">Unplaced ({unplaced.length})</Tabs.Trigger>
				<Tabs.Trigger value="hidden">Hidden ({hidden.length})</Tabs.Trigger>
			</Tabs.List>

			<ScrollArea class="min-h-0 flex-1">
				<div class="flex flex-col gap-4 p-3">
					{#each groups as group (group.category)}
						<section class="flex flex-col gap-2">
							<h3
								class="flex items-baseline gap-1.5 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
							>
								{group.label}
								<span class="font-normal tabular-nums">{group.items.length}</span>
							</h3>
							<ul class="flex flex-col gap-2">
								{#each group.items as el (el.id)}
									{@const meta = KIND_META[el.kind]}
									<li
										class={[
											'group flex items-start gap-2 rounded-md border bg-card p-2 text-card-foreground',
											group.category === 'observable' && 'border-dashed bg-muted/40'
										]}
										data-element-id={el.id}
										data-category={group.category}
									>
										{#if ui.panelTab === 'unplaced'}
											<button
												type="button"
												class="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
												aria-label="Drag onto the dashboard"
												onpointerdown={(e) => startPlace(e, el.id, el.kind, el.title || meta.label)}
											>
												<GripVerticalIcon class="size-4" />
											</button>
										{/if}
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-1.5 text-sm font-medium">
												<meta.icon class="size-3.5 shrink-0 text-muted-foreground" />
												<span class="truncate">{el.title || meta.label}</span>
											</div>
											<div class="text-xs text-muted-foreground">{meta.label}</div>
										</div>
										<div
											class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
										>
											{#if ui.panelTab === 'hidden'}
												<Button size="icon-sm" variant="ghost" aria-label="Show on dashboard" onclick={() => unhide(el.id)}>
													<EyeIcon class="size-4" />
												</Button>
											{/if}
											<Button
												size="icon-sm"
												variant="ghost"
												aria-label="Delete element"
												onclick={() => remove(el.id, el.title || meta.label)}
											>
												<Trash2Icon class="size-4" />
											</Button>
										</div>
									</li>
								{/each}
							</ul>
						</section>
					{:else}
						<p class="px-1 py-6 text-center text-sm text-muted-foreground">
							{#if ui.panelTab === 'unplaced'}
								Nothing here. Create an element to place it on the dashboard.
							{:else}
								No hidden elements. Hide a placed element to park it here.
							{/if}
						</p>
					{/each}
				</div>
			</ScrollArea>
		</Tabs.Root>
	</aside>
{/if}

<CreateElementDialog />
