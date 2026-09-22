<script lang="ts">
	import { AGGREGATION_FNS, fieldsOf, type AggregationConfig, type ElementRow } from 'shared';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { parseAggregationConfig } from '$lib/elements/config';
	import { CHART_TYPES, CHART_TYPE_LABEL, parseChartConfig, type ChartConfig, type ChartType } from '$lib/elements/chart-config';
	import { Checkbox } from '$lib/components/ui/checkbox';

	let { element, open = $bindable(false) }: { element: ElementRow; open?: boolean } = $props();

	const db = getDb();
	const dataflow = getDataflow();

	const datasources = liveQuery(db, (d) => d.call('listDatasources'), ['datasources']);
	const transformers = liveQuery(db, (d) => d.call('listTransformers'), ['transformers']);

	const options = $derived([
		...(datasources.value ?? []).map((d) => ({ key: `datasource:${d.id}` as const, label: d.name, group: 'Datasources' })),
		...(transformers.value ?? []).map((t) => ({ key: `transformer:${t.id}` as const, label: t.name, group: 'Transformers' }))
	]);

	const current = $derived(dataflow.producersOf(element.id)[0] ?? null);
	// Writable deriveds: seeded from the element, editable in the form, re-seeded when the element changes.
	let producer = $derived<string>(current ?? '');
	let config = $derived<AggregationConfig>(parseAggregationConfig(element.config_json));
	let chart = $derived<ChartConfig>(parseChartConfig(element.config_json));

	function cancel() {
		producer = current ?? '';
		config = parseAggregationConfig(element.config_json);
		chart = parseChartConfig(element.config_json);
		open = false;
	}

	function toggleSeries(field: string, on: boolean) {
		const y = on ? [...chart.y.filter((f) => f !== field), field] : chart.y.filter((f) => f !== field);
		chart = { ...chart, y };
	}

	const fields = $derived(producer ? fieldsOf(dataflow.get(producer as `${'datasource' | 'transformer'}:${string}`).value) : []);

	async function save() {
		try {
			if (producer !== (current ?? '')) {
				for (const e of await db.call('listEdges')) {
					if (e.consumer_kind === 'element' && e.consumer_id === element.id) await db.call('removeEdge', e.id);
				}
				if (producer) {
					const [kind, id] = producer.split(':') as ['datasource' | 'transformer', string];
					await db.call('addEdge', { producer_kind: kind, producer_id: id, consumer_kind: 'element', consumer_id: element.id });
				}
			}
			if (element.kind === 'aggregation') {
				const next: AggregationConfig = { fn: config.fn };
				if (config.field) next.field = config.field;
				await db.call('updateElement', element.id, { config: next as unknown as Record<string, unknown> });
			} else if (element.kind === 'chart') {
				await db.call('updateElement', element.id, { config: { ...chart } as unknown as Record<string, unknown> });
			}
			open = false;
		} catch (e) {
			toast.error('Could not bind data', { description: e instanceof Error ? e.message : String(e) });
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Bind data</Dialog.Title>
			<Dialog.Description>Choose what “{element.title}” reads from.</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<div class="grid gap-2">
				<Label>Source</Label>
				<Select.Root type="single" bind:value={producer}>
					<Select.Trigger class="w-full" aria-label="Source">
						{options.find((o) => o.key === producer)?.label ?? 'Nothing bound'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="Nothing bound">Nothing bound</Select.Item>
						{#each ['Datasources', 'Transformers'] as group (group)}
							{@const items = options.filter((o) => o.group === group)}
							{#if items.length}
								<Select.Group>
									<Select.GroupHeading>{group}</Select.GroupHeading>
									{#each items as o (o.key)}
										<Select.Item value={o.key} label={o.label}>{o.label}</Select.Item>
									{/each}
								</Select.Group>
							{/if}
						{/each}
					</Select.Content>
				</Select.Root>
				{#if options.length === 0}
					<p class="text-xs text-muted-foreground">No datasources yet. Create one under Datasources.</p>
				{/if}
			</div>

			{#if element.kind === 'chart'}
				<div class="grid grid-cols-2 gap-3">
					<div class="grid gap-2">
						<Label>Chart type</Label>
						<Select.Root type="single" value={chart.type} onValueChange={(v) => (chart = { ...chart, type: v as ChartType })}>
							<Select.Trigger class="w-full" aria-label="Chart type">{CHART_TYPE_LABEL[chart.type]}</Select.Trigger>
							<Select.Content>
								{#each CHART_TYPES as t (t)}
									<Select.Item value={t} label={CHART_TYPE_LABEL[t]}>{CHART_TYPE_LABEL[t]}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="grid gap-2">
						<Label>{chart.type === 'pie' || chart.type === 'radial' ? 'Label field' : 'X axis field'}</Label>
						<Select.Root type="single" value={chart.x} onValueChange={(v) => (chart = { ...chart, x: v })}>
							<Select.Trigger class="w-full" aria-label="X field">{chart.x || 'Record index'}</Select.Trigger>
							<Select.Content>
								<Select.Item value="" label="Record index">Record index</Select.Item>
								{#each fields as f (f)}
									<Select.Item value={f} label={f}>{f}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
				<div class="grid gap-2">
					<Label>{chart.type === 'pie' || chart.type === 'radial' ? 'Value field' : 'Series (numeric fields)'}</Label>
					{#if fields.length === 0}
						<p class="text-xs text-muted-foreground">Bind a source with records to pick fields.</p>
					{:else}
						<div class="flex flex-wrap gap-2" role="group" aria-label="Series">
							{#each fields.filter((f) => f !== chart.x) as f (f)}
								<label class="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
									<Checkbox checked={chart.y.includes(f)} onCheckedChange={(v) => toggleSeries(f, v === true)} aria-label={f} />
									{f}
								</label>
							{/each}
						</div>
					{/if}
				</div>
				{#if chart.type === 'bar'}
					<label class="flex items-center gap-2 text-sm">
						<Checkbox checked={chart.horizontal === true} onCheckedChange={(v) => (chart = { ...chart, horizontal: v === true })} aria-label="Horizontal bars" />
						Horizontal bars
					</label>
				{/if}
			{/if}

			{#if element.kind === 'aggregation'}
				<div class="grid grid-cols-2 gap-3">
					<div class="grid gap-2">
						<Label>Function</Label>
						<Select.Root type="single" value={config.fn} onValueChange={(v) => (config = { ...config, fn: v as AggregationConfig['fn'] })}>
							<Select.Trigger class="w-full" aria-label="Function">{config.fn}</Select.Trigger>
							<Select.Content>
								{#each AGGREGATION_FNS as fn (fn)}
									<Select.Item value={fn} label={fn}>{fn}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="grid gap-2">
						<Label>Field</Label>
						<Select.Root type="single" value={config.field ?? ''} onValueChange={(v) => (config = { ...config, field: v || undefined })}>
							<Select.Trigger class="w-full" aria-label="Field">{config.field ?? (config.fn === 'count' ? 'All records' : 'Pick a field')}</Select.Trigger>
							<Select.Content>
								{#if config.fn === 'count'}
									<Select.Item value="" label="All records">All records</Select.Item>
								{/if}
								{#each fields as f (f)}
									<Select.Item value={f} label={f}>{f}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={cancel}>Cancel</Button>
			<Button onclick={save}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
