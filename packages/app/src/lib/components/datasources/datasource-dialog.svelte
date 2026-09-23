<script lang="ts">
	import {
		BODY_TYPES,
		csvToRecords,
		decodeSecrets,
		formatHeaderLines,
		HTTP_METHODS,
		methodHasBody,
		MIN_POLL_INTERVAL_MS,
		parseHeaderLines,
		DEFAULT_TRACK_LIMIT,
		MAX_TRACK_LIMIT,
		MIN_TRACK_LIMIT,
		validateBody,
		type BodyType,
		type CreateDatasourceInput,
		type DatasourceKind,
		type DatasourceRow,
		type DatasourceSecrets,
		type ElementRow,
		type TrackMode
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
	import UploadIcon from '@lucide/svelte/icons/upload';

	const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

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
	const decoded = $derived(decodeSecrets(editing?.secrets_ciphertext));
	let headerText = $derived(editing ? formatHeaderLines(decoded.headers) : '');
	let bodyType = $derived<BodyType>(decoded.body_type);
	let bodyText = $derived(decoded.body ?? '');

	const BODY_LABEL: Record<BodyType, string> = { json: 'JSON', text: 'Text' };

	type TrackChoice = TrackMode | 'off';
	const TRACK_LABEL: Record<TrackChoice, string> = {
		off: 'Latest value only',
		sample: 'Record each fetch',
		merge: 'Merge rows by key'
	};
	const TRACK_HINT: Record<TrackChoice, string> = {
		off: 'Each poll replaces the last. Right for an API that already returns a series.',
		sample: 'Appends one row per poll, so a single current value becomes a series you can chart.',
		merge: "Upserts the response's rows on a key field, so the stored series can outgrow the window the API returns."
	};

	let trackMode = $derived<TrackChoice>(editing?.track_mode ?? 'off');
	let trackKey = $derived(editing?.track_key ?? '');
	let trackLimitText = $derived(String(editing?.track_limit ?? DEFAULT_TRACK_LIMIT));

	const trackFields = $derived(
		trackMode === 'off'
			? { track_mode: null, track_key: null, track_limit: null }
			: {
					track_mode: trackMode,
					track_key: trackMode === 'merge' ? trackKey.trim() : null,
					track_limit: Number(trackLimitText) || DEFAULT_TRACK_LIMIT
				}
	);

	let jsonError = $state<string | null>(null);
	let bodyError = $state<string | null>(null);
	let saving = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let imported = $state<{ file: string; records: number | null } | null>(null);

	/** Parses a local .json or .csv file into the static value; nothing leaves the device. */
	async function importFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > MAX_IMPORT_BYTES) {
			toast.error('File too large', { description: 'Static datasources are capped at 5 MB.' });
			return;
		}
		try {
			const text = await file.text();
			const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
			const value: unknown = isCsv ? csvToRecords(text) : JSON.parse(text);
			staticJson = JSON.stringify(value, null, 2);
			jsonError = null;
			imported = { file: file.name, records: Array.isArray(value) ? value.length : null };
			if (!name.trim()) name = file.name.replace(/\.[^.]+$/, '');
		} catch (err) {
			jsonError = `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const elementTitle = $derived(new Map(editables.map((e) => [e.id, e.title || KIND_META[e.kind].label])));

	function close() {
		open = false;
		jsonError = null;
		bodyError = null;
		imported = null;
	}

	/** Headers and body as stored in secrets_ciphertext; throws on an invalid JSON body. */
	function secrets(): DatasourceSecrets {
		const body = methodHasBody(method) && bodyText.trim() ? bodyText : undefined;
		validateBody(body, bodyType);
		return { headers: parseHeaderLines(headerText), body, body_type: bodyType };
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
					let sec: DatasourceSecrets;
					try {
						sec = secrets();
					} catch (e) {
						bodyError = e instanceof Error ? e.message : String(e);
						return;
					}
					await db.call('updateDatasource', editing.id, {
						name: n || editing.name,
						url: url.trim(),
						method,
						poll_interval_ms: Math.max(MIN_POLL_INTERVAL_MS, Number(intervalSec) * 1000 || 60_000),
						response_path: responsePath.trim() || null,
						secrets: sec,
						...trackFields
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
					let sec: DatasourceSecrets;
					try {
						sec = secrets();
					} catch (e) {
						bodyError = e instanceof Error ? e.message : String(e);
						return;
					}
					input = {
						kind: 'external',
						name: n || new URL(url.trim(), location.href).hostname,
						url: url.trim(),
						fetch_mode: 'poll',
						method,
						poll_interval_ms: Math.max(MIN_POLL_INTERVAL_MS, Number(intervalSec) * 1000 || 60_000),
						response_path: responsePath.trim() || undefined,
						secrets: sec,
						...trackFields
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
					<div class="flex items-center justify-between gap-2">
						<Label for="ds-json">JSON value</Label>
						<Button size="xs" variant="outline" onclick={() => fileInput?.click()}>
							<UploadIcon class="size-3.5" />
							Import file
						</Button>
						<input
							bind:this={fileInput}
							type="file"
							accept=".json,.csv,application/json,text/csv"
							class="hidden"
							onchange={importFile}
							data-testid="static-import"
						/>
					</div>
					<Textarea id="ds-json" bind:value={staticJson} rows={8} class="font-mono text-xs" aria-invalid={jsonError !== null} oninput={() => (imported = null)} />
					{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
					{#if imported}
						<p class="text-xs text-muted-foreground" data-testid="import-summary">
							{imported.records === null ? 'Imported' : `${imported.records} records`} from {imported.file}. CSV headers become field names; numbers and true/false are typed.
						</p>
					{/if}
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
					{#if editables.length === 0}<p class="text-xs text-muted-foreground">Create a task list or table first.</p>{/if}
				</div>
			{:else}
				<div class="grid grid-cols-[6rem_1fr] gap-2">
					<div class="grid gap-2">
						<Label>Method</Label>
						<Select.Root type="single" bind:value={method}>
							<Select.Trigger class="w-full" aria-label="Method">{method}</Select.Trigger>
							<Select.Content>
								{#each HTTP_METHODS as m (m)}
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
				<div class="grid gap-2" data-testid="track-section">
					<div class="grid grid-cols-2 gap-2">
						<div class="grid gap-2">
							<Label for="ds-track">History</Label>
							<Select.Root type="single" value={trackMode} onValueChange={(v) => (trackMode = v as TrackChoice)}>
								<Select.Trigger id="ds-track" aria-label="History">{TRACK_LABEL[trackMode]}</Select.Trigger>
								<Select.Content>
									{#each ['off', 'sample', 'merge'] as const as m (m)}
										<Select.Item value={m} label={TRACK_LABEL[m]}>{TRACK_LABEL[m]}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						{#if trackMode === 'merge'}
							<div class="grid gap-2">
								<Label for="ds-track-key">Key field</Label>
								<Input id="ds-track-key" bind:value={trackKey} placeholder="t" />
							</div>
						{:else if trackMode === 'sample'}
							<div class="grid gap-2">
								<Label for="ds-track-limit">Keep last</Label>
								<Input
									id="ds-track-limit"
									type="number"
									min={MIN_TRACK_LIMIT}
									max={MAX_TRACK_LIMIT}
									bind:value={trackLimitText}
								/>
							</div>
						{/if}
					</div>
					{#if trackMode === 'merge'}
						<div class="grid gap-2">
							<Label for="ds-track-limit-merge">Keep last</Label>
							<Input
								id="ds-track-limit-merge"
								type="number"
								min={MIN_TRACK_LIMIT}
								max={MAX_TRACK_LIMIT}
								bind:value={trackLimitText}
							/>
						</div>
					{/if}
					<p class="text-xs text-muted-foreground">{TRACK_HINT[trackMode]}</p>
					{#if trackMode !== 'off'}
						<p class="text-xs text-muted-foreground">
							A tracked source keeps polling while the app is open, even when nothing on the dashboard shows it.
							History is recorded per device and is not synced.
						</p>
					{/if}
				</div>
				<div class="grid gap-2">
					<Label for="ds-headers">Headers (one per line, <code>Key: Value</code>)</Label>
					<Textarea id="ds-headers" bind:value={headerText} rows={3} class="font-mono text-xs" placeholder="Authorization: Bearer …" />
				</div>
				{#if methodHasBody(method)}
					<div class="grid gap-2" data-testid="body-section">
						<div class="flex items-center justify-between gap-2">
							<Label for="ds-body">Body</Label>
							<Select.Root type="single" value={bodyType} onValueChange={(v) => (bodyType = v as BodyType)}>
								<Select.Trigger class="h-7 w-24 text-xs" aria-label="Body type">{BODY_LABEL[bodyType]}</Select.Trigger>
								<Select.Content>
									{#each BODY_TYPES as t (t)}
										<Select.Item value={t} label={BODY_LABEL[t]}>{BODY_LABEL[t]}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<Textarea
							id="ds-body"
							bind:value={bodyText}
							rows={6}
							class="font-mono text-xs"
							placeholder={bodyType === 'json' ? '{ "query": "…" }' : 'raw request body'}
							aria-invalid={bodyError !== null}
							oninput={() => (bodyError = null)}
						/>
						{#if bodyError}<p class="text-xs text-destructive">{bodyError}</p>{/if}
						<p class="text-xs text-muted-foreground">
							Sent as <code>{bodyType === 'json' ? 'application/json' : 'text/plain'}</code> unless you set a <code>Content-Type</code> header.
						</p>
					</div>
				{/if}
				<p class="text-xs text-muted-foreground">
					The API must allow browser requests (CORS). Without an account, headers and body are stored unencrypted on this device.
				</p>
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
