<script lang="ts">
	import type { CreateDatasourceInput, DatasourceRow } from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { KIND_META } from '$lib/elements/kinds';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	const db = getDb();
	const dataflow = getDataflow();

	const datasources = liveQuery(db, (d) => d.call('listDatasources'), ['datasources']);
	const elements = liveQuery(db, (d) => d.call('listElements'), ['elements']);
	const editables = $derived((elements.value ?? []).filter((e) => KIND_META[e.kind].category === 'editable'));
	const elementTitle = $derived(new Map((elements.value ?? []).map((e) => [e.id, e.title || KIND_META[e.kind].label])));

	let open = $state(false);
	let kind = $state<'static' | 'internal'>('static');
	let name = $state('');
	let staticJson = $state('[\n  { "label": "a", "value": 1 },\n  { "label": "b", "value": 2 }\n]');
	let sourceElement = $state('');
	let jsonError = $state<string | null>(null);

	function reset() {
		kind = 'static';
		name = '';
		sourceElement = '';
		jsonError = null;
	}

	async function create() {
		let input: CreateDatasourceInput;
		const n = name.trim();
		if (kind === 'static') {
			let value: unknown;
			try {
				value = JSON.parse(staticJson);
				jsonError = null;
			} catch (e) {
				jsonError = e instanceof Error ? e.message : String(e);
				return;
			}
			input = { kind: 'static', name: n || 'Static values', value };
		} else {
			if (!sourceElement) return;
			input = { kind: 'internal', name: n || `${elementTitle.get(sourceElement)} data`, source_element_id: sourceElement };
		}
		try {
			await db.call('createDatasource', input);
			open = false;
			reset();
			toast.success('Datasource created');
		} catch (e) {
			toast.error('Could not create datasource', { description: e instanceof Error ? e.message : String(e) });
		}
	}

	async function remove(ds: DatasourceRow) {
		await db.call('deleteDatasource', ds.id);
		toast(`Deleted “${ds.name}”`);
	}

	function preview(ds: DatasourceRow): string {
		const s = dataflow.get(`datasource:${ds.id}`);
		if (s.status === 'error') return `Error: ${s.error}`;
		if (s.status !== 'ok') return s.status;
		const text = JSON.stringify(s.value, null, 1) ?? 'null';
		return text.length > 400 ? text.slice(0, 400) + '…' : text;
	}

	function recordCount(ds: DatasourceRow): number | null {
		const v = dataflow.get(`datasource:${ds.id}`).value;
		return Array.isArray(v) ? v.length : null;
	}
</script>

<svelte:head><title>Datasources · DashIt</title></svelte:head>

<div class="p-6">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Datasources</h1>
			<p class="text-sm text-muted-foreground">Static values and editable elements exposed as data. External APIs arrive in a later phase.</p>
		</div>
		<Button onclick={() => (open = true)}>
			<PlusIcon class="size-4" />
			New datasource
		</Button>
	</div>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each datasources.value ?? [] as ds (ds.id)}
			<Card.Root data-datasource-id={ds.id}>
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<span class="truncate">{ds.name}</span>
						<Badge variant="secondary">{ds.kind}</Badge>
						{#if dataflow.activeDatasourceIds.has(ds.id)}
							<Badge variant="outline">active</Badge>
						{/if}
					</Card.Title>
					<Card.Description>
						{#if ds.kind === 'internal'}
							From “{elementTitle.get(ds.source_element_id ?? '') ?? 'deleted element'}”
						{:else if ds.kind === 'static'}
							Constant value
						{:else}
							{ds.url}
						{/if}
						{#if recordCount(ds) !== null}
							· {recordCount(ds)} records
						{/if}
					</Card.Description>
					<Card.Action>
						<Button size="icon-sm" variant="ghost" aria-label="Delete datasource" onclick={() => remove(ds)}>
							<Trash2Icon class="size-4" />
						</Button>
					</Card.Action>
				</Card.Header>
				<Card.Content>
					<pre class="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{preview(ds)}</pre>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No datasources yet.
			</p>
		{/each}
	</div>
</div>

<Dialog.Root bind:open onOpenChange={(o) => !o && reset()}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New datasource</Dialog.Title>
		</Dialog.Header>
		<div class="grid gap-4">
			<div class="grid gap-2">
				<Label>Type</Label>
				<Select.Root type="single" bind:value={kind}>
					<Select.Trigger class="w-full" aria-label="Type">{kind === 'static' ? 'Static values' : 'Element data (internal)'}</Select.Trigger>
					<Select.Content>
						<Select.Item value="static" label="Static values">Static values</Select.Item>
						<Select.Item value="internal" label="Element data (internal)">Element data (internal)</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			<div class="grid gap-2">
				<Label for="ds-name">Name</Label>
				<Input id="ds-name" bind:value={name} placeholder={kind === 'static' ? 'Static values' : 'Element data'} />
			</div>
			{#if kind === 'static'}
				<div class="grid gap-2">
					<Label for="ds-json">JSON value</Label>
					<Textarea id="ds-json" bind:value={staticJson} rows={8} class="font-mono text-xs" aria-invalid={jsonError !== null} />
					{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
				</div>
			{:else}
				<div class="grid gap-2">
					<Label>Element</Label>
					<Select.Root type="single" bind:value={sourceElement}>
						<Select.Trigger class="w-full" aria-label="Element">{elementTitle.get(sourceElement) ?? 'Pick an editable element'}</Select.Trigger>
						<Select.Content>
							{#each editables as el (el.id)}
								<Select.Item value={el.id} label={el.title || KIND_META[el.kind].label}>{el.title || KIND_META[el.kind].label} <span class="text-muted-foreground">· {KIND_META[el.kind].label}</span></Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if editables.length === 0}<p class="text-xs text-muted-foreground">Create a task, checklist or table first.</p>{/if}
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={create} disabled={kind === 'internal' && !sourceElement}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
