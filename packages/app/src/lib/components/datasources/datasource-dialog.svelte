<script lang="ts">
	import {
		decodeSecrets,
		formatHeaderLines,
		MIN_POLL_INTERVAL_MS,
		parseHeaderLines,
		type CreateDatasourceInput,
		type DatasourceKind,
		type DatasourceRow,
		type ElementRow
	} from 'shared';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { getDb } from '$lib/db/context';
	import { KIND_META } from '$lib/elements/kinds';

	let {
		open = $bindable(false),
		editing = null,
		editables
	}: {
		open?: boolean;
		/** Existing datasource to edit; null creates a new one. */
		editing?: DatasourceRow | null;
		editables: ElementRow[];
	} = $props();

	const db = getDb();

	const KIND_LABEL: Record<DatasourceKind, string> = {
		static: 'Static values',
		internal: 'Element data (internal)',
		external: 'External API (HTTP polling)'
	};

	// Form fields are writable deriveds: seeded from `editing`, then edited freely.
	let kind = $derived<DatasourceKind>(editing?.kind ?? 'static');
	let name = $derived(editing?.name ?? '');
	let staticJson = $derived(
		editing?.kind === 'static' && editing.static_value_json
			? JSON.stringify(JSON.parse(editing.static_value_json), null, 2)
			: '[\n  { "label": "a", "value": 1 },\n  { "label": "b", "value": 2 }\n]'
	);
	let sourceElement = $derived(editing?.source_element_id ?? '');
	let url = $derived(editing?.url ?? '');
	let method = $derived(editing?.method ?? 'GET');
	let intervalSec = $derived(String(Math.round((editing?.poll_interval_ms ?? 60_000) / 1000)));
	let responsePath = $derived(editing?.response_path ?? '');
	let headerText = $derived(editing ? formatHeaderLines(decodeSecrets(editing.secrets_ciphertext).headers) : '');

	let jsonError = $state<string | null>(null);
	let saving = $state(false);

	const elementTitle = $derived(new Map(editables.map((e) => [e.id, e.title || KIND_META[e.kind].label])));

	function close() {
		open = false;
		jsonError = null;
	}

	async function save() {
		saving = true;
		try {
			const n = name.trim();
			if (editing) {
				if (kind === 'static') {
					let value: unknown;
					try {
						value = JSON.parse(staticJson);
					} catch (e) {
						jsonError = e instanceof Error ? e.message : String(e);
						return;
					}
					await db.call('updateDatasource', editing.id, { name: n || editing.name, static_value: value });
				} else if (kind === 'external') {
					await db.call('updateDatasource', editing.id, {
						name: n || editing.name,
						url: url.trim(),
						method,
						poll_interval_ms: Math.max(MIN_POLL_INTERVAL_MS, Number(intervalSec) * 1000 || 60_000),
						response_path: responsePath.trim() || null,
						headers: parseHeaderLines(headerText)
					});
				} else {
					await db.call('updateDatasource', editing.id, { name: n || editing.name });
				}
				toast.success('Datasource updated');
			} else {
				let input: CreateDatasourceInput;
				if (kind === 'static') {
					let value: unknown;
					try {
						value = JSON.parse(staticJson);
					} catch (e) {
						jsonError = e instanceof Error ? e.message : String(e);
						return;
					}
					input = { kind: 'static', name: n || 'Static values', value };
				} else if (kind === 'internal') {
					if (!sourceElement) return;
					input = { kind: 'internal', name: n || `${elementTitle.get(sourceElement)} data`, source_element_id: sourceElement };
				} else {
					if (!url.trim()) return;
					input = {
						kind: 'external',
						name: n || new URL(url.trim(), location.href).hostname,
						url: url.trim(),
						fetch_mode: 'poll',
						method,
						poll_interval_ms: Math.max(MIN_POLL_INTERVAL_MS, Number(intervalSec) * 1000 || 60_000),
						response_path: responsePath.trim() || undefined,
						headers: parseHeaderLines(headerText)
					};
				}
				await db.call('createDatasource', input);
				toast.success('Datasource created');
			}
			close();
		} catch (e) {
			toast.error('Could not save datasource', { description: e instanceof Error ? e.message : String(e) });
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && close()}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Edit datasource' : 'New datasource'}</Dialog.Title>
		</Dialog.Header>
		<div class="grid gap-4">
			{#if !editing}
				<div class="grid gap-2">
					<Label>Type</Label>
					<Select.Root type="single" bind:value={kind}>
						<Select.Trigger class="w-full" aria-label="Type">{KIND_LABEL[kind]}</Select.Trigger>
						<Select.Content>
							{#each Object.entries(KIND_LABEL) as [k, label] (k)}
								<Select.Item value={k} {label}>{label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			{/if}
			<div class="grid gap-2">
				<Label for="ds-name">Name</Label>
				<Input id="ds-name" bind:value={name} placeholder={KIND_LABEL[kind]} />
			</div>

			{#if kind === 'static'}
				<div class="grid gap-2">
					<Label for="ds-json">JSON value</Label>
					<Textarea id="ds-json" bind:value={staticJson} rows={8} class="font-mono text-xs" aria-invalid={jsonError !== null} />
					{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
				</div>
			{:else if kind === 'internal'}
				<div class="grid gap-2">
					<Label>Element</Label>
					<Select.Root type="single" bind:value={sourceElement} disabled={editing !== null}>
						<Select.Trigger class="w-full" aria-label="Element">{elementTitle.get(sourceElement) ?? 'Pick an editable element'}</Select.Trigger>
						<Select.Content>
							{#each editables as el (el.id)}
								<Select.Item value={el.id} label={el.title || KIND_META[el.kind].label}>
									{el.title || KIND_META[el.kind].label} <span class="text-muted-foreground">· {KIND_META[el.kind].label}</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if editables.length === 0}<p class="text-xs text-muted-foreground">Create a task, checklist or table first.</p>{/if}
				</div>
			{:else}
				<div class="grid grid-cols-[6rem_1fr] gap-2">
					<div class="grid gap-2">
						<Label>Method</Label>
						<Select.Root type="single" bind:value={method}>
							<Select.Trigger class="w-full" aria-label="Method">{method}</Select.Trigger>
							<Select.Content>
								{#each ['GET', 'POST'] as m (m)}
									<Select.Item value={m} label={m}>{m}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="grid gap-2">
						<Label for="ds-url">URL</Label>
						<Input id="ds-url" bind:value={url} placeholder="https://api.example.com/data" inputmode="url" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-2">
					<div class="grid gap-2">
						<Label for="ds-interval">Poll every (seconds)</Label>
						<Input id="ds-interval" type="number" min={MIN_POLL_INTERVAL_MS / 1000} bind:value={intervalSec} />
					</div>
					<div class="grid gap-2">
						<Label for="ds-path">Response path</Label>
						<Input id="ds-path" bind:value={responsePath} placeholder="data.items or /data/items" />
					</div>
				</div>
				<div class="grid gap-2">
					<Label for="ds-headers">Headers (one per line, <code>Key: Value</code>)</Label>
					<Textarea id="ds-headers" bind:value={headerText} rows={3} class="font-mono text-xs" placeholder="Authorization: Bearer …" />
					<p class="text-xs text-muted-foreground">
						The API must allow browser requests (CORS). Without an account, headers are stored unencrypted on this device.
					</p>
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={close}>Cancel</Button>
			<Button onclick={save} disabled={saving || (kind === 'internal' && !sourceElement) || (kind === 'external' && !url.trim())}>
				{editing ? 'Save' : 'Create'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
