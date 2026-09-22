<script lang="ts">
	import type { ColumnType } from 'shared';
	import { Checkbox } from '$lib/components/ui/checkbox';

	let { type, value, onchange }: { type: ColumnType; value: unknown; onchange: (value: unknown) => void } = $props();

	// Local draft while focused so typing does not round-trip through the database per keystroke.
	let draft = $state<string | null>(null);

	const display = $derived.by(() => {
		if (value === null || value === undefined) return '';
		if (type === 'date' && typeof value === 'string') return value.slice(0, 10);
		return String(value);
	});

	function parse(raw: string): unknown {
		const t = raw.trim();
		if (t === '') return null;
		switch (type) {
			case 'number': {
				const n = Number(t);
				return Number.isFinite(n) ? n : null;
			}
			case 'date':
				return t; // ISO yyyy-mm-dd from the native date input
			default:
				return t;
		}
	}

	function commit() {
		if (draft === null) return;
		const next = parse(draft);
		draft = null;
		if (next !== (value ?? null)) onchange(next);
	}
</script>

{#if type === 'boolean'}
	<div class="flex h-8 items-center justify-center">
		<Checkbox checked={value === true} onCheckedChange={(v) => onchange(v === true)} aria-label="Value" />
	</div>
{:else}
	<input
		class="h-8 w-full min-w-24 bg-transparent px-2 text-sm outline-none focus:bg-background focus:ring-1 focus:ring-inset focus:ring-ring"
		type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
		value={draft ?? display}
		oninput={(e) => (draft = e.currentTarget.value)}
		onblur={commit}
		onkeydown={(e) => {
			if (e.key === 'Enter') e.currentTarget.blur();
			if (e.key === 'Escape') {
				draft = null;
				e.currentTarget.blur();
			}
		}}
		aria-label="Value"
	/>
{/if}
