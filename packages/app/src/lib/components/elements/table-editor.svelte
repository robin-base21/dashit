<script lang="ts">
	import { COLUMN_TYPES, type ColumnType, type TableColumnRow } from 'shared';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import TableCell from './table-cell.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	let { elementId }: { elementId: string } = $props();

	const db = getDb();
	const columns = liveQuery(db, (d) => d.call('listTableColumns', elementId), ['table_columns']);
	const rows = liveQuery(db, (d) => d.call('listTableRows', elementId), ['table_rows']);
	const cells = liveQuery(db, (d) => d.call('listTableCells', elementId), ['table_cells', 'table_rows']);

	const cellMap = $derived.by(() => {
		const m = new Map<string, unknown>();
		for (const c of cells.value ?? []) m.set(`${c.row_id}:${c.column_id}`, c.value_json === null ? null : JSON.parse(c.value_json));
		return m;
	});

	const TYPE_LABEL: Record<ColumnType, string> = { string: 'Text', number: 'Number', date: 'Date', boolean: 'Yes/No' };

	let renaming = $state<string | null>(null);
	let renameDraft = $state('');

	async function addColumn() {
		await db.call('addTableColumn', { element_id: elementId });
	}

	async function addRow() {
		await db.call('addTableRow', { element_id: elementId });
	}

	function startRename(col: TableColumnRow) {
		renaming = col.id;
		renameDraft = col.name;
	}

	async function commitRename(col: TableColumnRow) {
		if (renaming !== col.id) return;
		renaming = null;
		const name = renameDraft.trim();
		if (name && name !== col.name) await db.call('updateTableColumn', col.id, { name });
	}

	async function setType(col: TableColumnRow, data_type: ColumnType) {
		await db.call('updateTableColumn', col.id, { data_type });
	}

	async function setCell(row_id: string, column_id: string, value: unknown) {
		await db.call('setTableCell', { row_id, column_id, value });
	}
</script>

<div class="flex h-full flex-col text-sm">
	<div class="min-h-0 flex-1 overflow-auto">
		<table class="w-full border-collapse">
			<thead class="sticky top-0 z-10 bg-card">
				<tr>
					{#each columns.value ?? [] as col (col.id)}
						<th class="group border-b border-r px-1 py-1 text-left font-medium last:border-r-0">
							<div class="flex items-center gap-1">
								{#if renaming === col.id}
									<!-- svelte-ignore a11y_autofocus -->
									<input
										class="min-w-0 flex-1 rounded bg-transparent px-1 outline-none focus:ring-1 focus:ring-ring"
										bind:value={renameDraft}
										autofocus
										onblur={() => commitRename(col)}
										onkeydown={(e) => {
											if (e.key === 'Enter') commitRename(col);
											if (e.key === 'Escape') renaming = null;
										}}
									/>
								{:else}
									<button type="button" class="min-w-0 flex-1 truncate px-1 text-left" ondblclick={() => startRename(col)} title="Double-click to rename">
										{col.name}
									</button>
								{/if}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button {...props} size="icon-xs" variant="ghost" class="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Column options">
												<ChevronDownIcon class="size-3.5" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="start">
										<DropdownMenu.Item onclick={() => startRename(col)}>Rename</DropdownMenu.Item>
										<DropdownMenu.Sub>
											<DropdownMenu.SubTrigger>Type: {TYPE_LABEL[col.data_type]}</DropdownMenu.SubTrigger>
											<DropdownMenu.SubContent>
												{#each COLUMN_TYPES as t (t)}
													<DropdownMenu.CheckboxItem checked={col.data_type === t} onCheckedChange={() => setType(col, t)}>
														{TYPE_LABEL[t]}
													</DropdownMenu.CheckboxItem>
												{/each}
											</DropdownMenu.SubContent>
										</DropdownMenu.Sub>
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onclick={() => db.call('deleteTableColumn', col.id)}>
											<Trash2Icon class="size-4" />
											Delete column
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</div>
						</th>
					{/each}
					<th class="w-8 border-b px-1 py-1">
						<Button size="icon-xs" variant="ghost" aria-label="Add column" onclick={addColumn}>
							<PlusIcon class="size-3.5" />
						</Button>
					</th>
				</tr>
			</thead>
			<tbody>
				{#each rows.value ?? [] as row (row.id)}
					<tr class="group hover:bg-accent/40" data-row-id={row.id}>
						{#each columns.value ?? [] as col (col.id)}
							<td class="border-b border-r p-0 last:border-r-0">
								<TableCell type={col.data_type} value={cellMap.get(`${row.id}:${col.id}`) ?? null} onchange={(v) => setCell(row.id, col.id, v)} />
							</td>
						{/each}
						<td class="border-b p-0 text-center">
							<Button size="icon-xs" variant="ghost" class="opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete row" onclick={() => db.call('deleteTableRow', row.id)}>
								<Trash2Icon class="size-3.5" />
							</Button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if (columns.value?.length ?? 0) === 0}
			<p class="p-3 text-center text-xs text-muted-foreground">Add a column to get started.</p>
		{/if}
	</div>
	<div class="flex items-center gap-1 border-t px-2 py-1">
		<Button size="xs" variant="ghost" onclick={addRow} disabled={(columns.value?.length ?? 0) === 0}>
			<PlusIcon class="size-3.5" />
			Add row
		</Button>
		<span class="ml-auto text-xs tabular-nums text-muted-foreground">{rows.value?.length ?? 0} rows</span>
	</div>
</div>
