<script lang="ts">
	import type { ElementRow } from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getUi, type DragSession } from '$lib/state/ui.svelte';
	import { diffLayout, resolveLayout, type Rect } from 'shared';
	import ElementCard from '$lib/components/elements/element-card.svelte';
	import BoxesIcon from '@lucide/svelte/icons/boxes';

	let { dashboardId }: { dashboardId: string } = $props();

	const db = getDb();
	const ui = getUi();

	const ROW_HEIGHT = 72;
	const GAP = 12;

	const dashboards = liveQuery(db, (d) => d.call('listDashboards'), ['dashboards']);
	const placements = liveQuery(db, (d) => d.call('listPlacements', dashboardId), ['placements', 'elements']);
	const elements = liveQuery(db, (d) => d.call('listElements'), ['elements']);

	const cols = $derived(dashboards.value?.find((d) => d.id === dashboardId)?.grid_cols ?? 12);
	const elementById = $derived(new Map((elements.value ?? []).map((e) => [e.id, e])));

	const visible = $derived((placements.value ?? []).filter((p) => !p.hidden && elementById.has(p.element_id)));
	const rects = $derived<Rect[]>(visible.map((p) => ({ id: p.element_id, x: p.x, y: p.y, w: p.w, h: p.h })));

	let gridEl = $state<HTMLDivElement | null>(null);

	// Cell offset between the pointer and the item's top-left at drag start (move only).
	let grab = $state<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

	function cellAt(px: number, py: number): { col: number; row: number; inside: boolean } | null {
		if (!gridEl) return null;
		const r = gridEl.getBoundingClientRect();
		const cellW = (r.width - GAP * (cols - 1)) / cols;
		const col = Math.floor((px - r.left + GAP / 2) / (cellW + GAP));
		const row = Math.floor((py - r.top + GAP / 2) / (ROW_HEIGHT + GAP));
		const inside = px >= r.left && px <= r.right && py >= r.top - 40 && py <= Math.max(r.bottom, r.top + 400) + 200;
		return { col: Math.max(0, Math.min(cols - 1, col)), row: Math.max(0, row), inside };
	}

	/** Target rect for the active drag, or null when a place-drag is outside the grid. */
	const target = $derived.by<Rect | null>(() => {
		const d = ui.drag;
		if (!d || !d.started) return null;
		const cell = cellAt(d.x, d.y);
		if (!cell) return null;
		switch (d.kind) {
			case 'place':
				if (!cell.inside) return null;
				return { id: d.elementId, x: cell.col - Math.floor((d.w - 1) / 2), y: cell.row, w: d.w, h: d.h };
			case 'move':
				return { id: d.elementId, x: cell.col - grab.dx, y: cell.row - grab.dy, w: d.w, h: d.h };
			case 'resize': {
				const o = d.origin!;
				return { id: d.elementId, x: o.x, y: o.y, w: Math.max(1, cell.col - o.x + 1), h: Math.max(1, cell.row - o.y + 1) };
			}
		}
	});

	const preview = $derived<Rect[]>(target ? resolveLayout(rects, target, cols) : rects);
	const previewById = $derived(new Map(preview.map((r) => [r.id, r])));
	const placeholder = $derived(target && ui.drag?.kind === 'place' ? previewById.get(target.id) ?? null : null);
	const rowCount = $derived(Math.max(6, ...preview.map((r) => r.y + r.h)) + 1);

	function startMove(e: PointerEvent, el: ElementRow, rect: Rect) {
		if (e.button !== 0) return;
		e.preventDefault();
		const cell = cellAt(e.clientX, e.clientY);
		grab = cell ? { dx: cell.col - rect.x, dy: cell.row - rect.y } : { dx: 0, dy: 0 };
		ui.beginDrag({ kind: 'move', elementId: el.id, label: el.title, w: rect.w, h: rect.h, origin: rect, startX: e.clientX, startY: e.clientY });
	}

	function startResize(e: PointerEvent, el: ElementRow, rect: Rect) {
		if (e.button !== 0) return;
		e.preventDefault();
		ui.beginDrag({ kind: 'resize', elementId: el.id, label: el.title, w: rect.w, h: rect.h, origin: rect, startX: e.clientX, startY: e.clientY });
	}

	function onpointermove(e: PointerEvent) {
		if (ui.drag) ui.updateDrag(e.clientX, e.clientY);
	}

	async function onpointerup() {
		const d = ui.drag;
		if (!d) return;
		const finalTarget = target;
		const finalPreview = preview;
		const before = rects;
		ui.endDrag();
		if (!d.started) return;
		await commit(d, finalTarget, before, finalPreview);
	}

	function onpointercancel() {
		ui.endDrag();
	}

	async function commit(d: DragSession, t: Rect | null, before: Rect[], after: Rect[]) {
		try {
			if (d.kind === 'place') {
				if (!t) return;
				const placed = after.find((r) => r.id === d.elementId)!;
				await db.call('placeElement', d.elementId, { dashboard_id: dashboardId, ...placed });
				await db.call('applyLayout', diffLayout(before, after.filter((r) => r.id !== d.elementId)));
			} else {
				await db.call('applyLayout', diffLayout(before, after));
			}
		} catch (e) {
			toast.error('Could not update the layout', { description: e instanceof Error ? e.message : String(e) });
		}
	}
</script>

<svelte:window {onpointermove} {onpointerup} {onpointercancel} />

<div
	bind:this={gridEl}
	class={['relative grid w-full', ui.drag?.started && 'select-none']}
	style:grid-template-columns="repeat({cols}, minmax(0, 1fr))"
	style:grid-auto-rows="{ROW_HEIGHT}px"
	style:gap="{GAP}px"
	style:min-height="{rowCount * (ROW_HEIGHT + GAP)}px"
	data-testid="dashboard-grid"
>
	{#each visible as p (p.element_id)}
		{@const el = elementById.get(p.element_id)!}
		{@const r = previewById.get(p.element_id) ?? { id: p.element_id, x: p.x, y: p.y, w: p.w, h: p.h }}
		<div
			class={['min-h-0 min-w-0', ui.drag?.started && 'transition-[grid-area] duration-150']}
			style:grid-column="{r.x + 1} / span {r.w}"
			style:grid-row="{r.y + 1} / span {r.h}"
		>
			<ElementCard
				element={el}
				dragging={ui.drag?.started === true && ui.drag.elementId === el.id}
				onmovestart={(e) => startMove(e, el, { id: el.id, x: p.x, y: p.y, w: p.w, h: p.h })}
				onresizestart={(e) => startResize(e, el, { id: el.id, x: p.x, y: p.y, w: p.w, h: p.h })}
			/>
		</div>
	{/each}

	{#if placeholder}
		<div
			class="rounded-lg border-2 border-dashed border-primary/60 bg-primary/5"
			style:grid-column="{placeholder.x + 1} / span {placeholder.w}"
			style:grid-row="{placeholder.y + 1} / span {placeholder.h}"
			aria-hidden="true"
		></div>
	{/if}

	{#if visible.length === 0 && !placeholder}
		<div class="col-span-full row-span-3 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
			<BoxesIcon class="size-6" />
			<p>Your dashboard is empty. Create an element and drag it here.</p>
			<Button variant="outline" size="sm" onclick={() => ui.openElementsPanel('unplaced')}>Open elements</Button>
		</div>
	{/if}
</div>
