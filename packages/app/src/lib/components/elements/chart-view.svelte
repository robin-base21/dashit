<script lang="ts">
	import { toNumber, toRecords, type ElementRow } from 'shared';
	import { scaleBand } from 'd3-scale';
	import { curveLinearClosed } from 'd3-shape';
	import { AreaChart, ArcChart, BarChart, Chart, LineChart, PieChart, Spline } from 'layerchart';
	import * as ChartUi from '$lib/components/ui/chart';
	import { Button } from '$lib/components/ui/button';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import { labelFormatters, MAX_CATEGORY_TICKS, parseChartConfig, seriesColor } from '$lib/elements/chart-config';
	import BindDataDialog from './bind-data-dialog.svelte';
	import LinkIcon from '@lucide/svelte/icons/link';

	let { element }: { element: ElementRow } = $props();

	const dataflow = getDataflow();
	const config = $derived(parseChartConfig(element.config_json));
	const bound = $derived(dataflow.datasetOf(element.id));

	type Row = Record<string, unknown> & { __x: string; __i: number };

	// Records with the x field coerced to a label string and y fields to numbers (or null).
	const rows = $derived.by<Row[]>(() => {
		if (bound.state.status !== 'ok') return [];
		return toRecords(bound.state.value).map((r, i) => {
			const out: Row = { ...r, __x: config.x ? String(r[config.x] ?? '') : String(i + 1), __i: i };
			for (const f of config.y) out[f] = toNumber(r[f]);
			return out;
		});
	});

	// Timestamps are stored as ISO strings; localize them for display only, never in `__x`, which
	// is the band-scale domain key and has to stay unique.
	const xLabel = $derived(labelFormatters(rows.map((r) => r.__x)));

	const series = $derived(config.y.map((key, i) => ({ key, label: key, color: seriesColor(i) })));
	const chartConfig = $derived(Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartUi.ChartConfig);

	// Pie / radial: one slice per record, colored per record.
	const slices = $derived(rows.map((r, i) => ({ key: r.__x || String(i + 1), value: (r[config.y[0] ?? ''] as number | null) ?? 0, color: seriesColor(i) })));
	const sliceConfig = $derived(Object.fromEntries(slices.map((s) => [s.key, { label: xLabel.tick(s.key), color: s.color }])) satisfies ChartUi.ChartConfig);

	const ready = $derived(bound.state.status === 'ok' && config.y.length > 0 && rows.length > 0);

	// Radar: long format (one row per record × series).
	const radarRows = $derived(rows.flatMap((r) => config.y.map((f) => ({ axis: r.__x, series: f, value: (r[f] as number | null) ?? 0 }))));
	const radarMax = $derived(Math.max(1, ...radarRows.map((r) => r.value)));

	// Cap the labels on whichever axis carries the categories — the x axis, or the y axis when bars
	// run horizontally. Without it a band scale draws its whole domain (see MAX_CATEGORY_TICKS).
	const categoryAxis = $derived(
		config.horizontal && config.type === 'bar'
			? { yAxis: { ticks: MAX_CATEGORY_TICKS, format: xLabel.tick } }
			: { xAxis: { ticks: MAX_CATEGORY_TICKS, format: xLabel.tick } }
	);

	let bindOpen = $state(false);
</script>

<div class="flex h-full flex-col p-2" data-testid="chart" data-chart-type={config.type}>
	{#if bound.state.status === 'unbound' || config.y.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center gap-1 text-center">
			<p class="text-xs text-muted-foreground">
				{bound.state.status === 'unbound' ? 'Not bound to any data.' : 'Pick the fields to chart.'}
			</p>
			<Button size="xs" variant="outline" onclick={() => (bindOpen = true)}>
				<LinkIcon class="size-3.5" />
				{bound.state.status === 'unbound' ? 'Bind data' : 'Configure'}
			</Button>
		</div>
	{:else if bound.state.status === 'error'}
		<p class="m-auto text-xs text-destructive" title={bound.state.error ?? ''}>Error in source</p>
	{:else if !ready}
		<p class="m-auto text-xs text-muted-foreground">No data yet.</p>
	{:else if config.type === 'pie' || config.type === 'radial'}
		<ChartUi.Container config={sliceConfig} class="aspect-auto h-full w-full">
			{#if config.type === 'pie'}
				<PieChart data={slices} key="key" value="value" c="key" cRange={slices.map((s) => s.color)} innerRadius={-20} padAngle={0.02} cornerRadius={3}>
					{#snippet tooltip()}
						<ChartUi.Tooltip nameKey="key" hideLabel />
					{/snippet}
				</PieChart>
			{:else}
				<ArcChart data={slices} key="key" value="value" c="key" cRange={slices.map((s) => s.color)} maxValue={Math.max(1, ...slices.map((s) => s.value))} innerRadius={-20} padAngle={0.02} cornerRadius={4}>
					{#snippet tooltip()}
						<ChartUi.Tooltip nameKey="key" hideLabel />
					{/snippet}
				</ArcChart>
			{/if}
		</ChartUi.Container>
	{:else if config.type === 'radar'}
		<ChartUi.Container config={chartConfig} class="aspect-auto h-full w-full">
			<Chart
				data={radarRows}
				x="axis"
				xScale={scaleBand()}
				y="value"
				yDomain={[0, radarMax]}
				yPadding={[0, 8]}
				padding={24}
				radial
				props={{ xAxis: { ticks: MAX_CATEGORY_TICKS, format: xLabel.tick }, yAxis: { ticks: 4 }, grid: { class: 'stroke-border/60' } }}
			>
				{#snippet marks()}
					{#each series as s (s.key)}
						<Spline data={radarRows.filter((r) => r.series === s.key)} curve={curveLinearClosed} stroke={s.color} fill={s.color} fillOpacity={0.2} class="stroke-2" />
					{/each}
				{/snippet}
			</Chart>
		</ChartUi.Container>
	{:else}
		<ChartUi.Container config={chartConfig} class="aspect-auto h-full w-full">
			{#if config.type === 'bar'}
				<BarChart data={rows} x="__x" xScale={scaleBand().padding(0.25)} orientation={config.horizontal ? 'horizontal' : 'vertical'} axis={config.horizontal ? 'y' : 'x'} seriesLayout="group" {series} props={{ bars: { radius: 3 }, ...categoryAxis }}>
					{#snippet tooltip()}
						<ChartUi.Tooltip labelFormatter={(v) => xLabel.full(v)} />
					{/snippet}
				</BarChart>
			{:else if config.type === 'line'}
				<LineChart data={rows} x="__x" xScale={scaleBand()} {series} props={{ spline: { class: 'stroke-2' }, ...categoryAxis }}>
					{#snippet tooltip()}
						<ChartUi.Tooltip labelFormatter={(v) => xLabel.full(v)} />
					{/snippet}
				</LineChart>
			{:else}
				<AreaChart data={rows} x="__x" xScale={scaleBand()} {series} props={{ area: { fillOpacity: 0.25, line: { class: 'stroke-2' } }, ...categoryAxis }}>
					{#snippet tooltip()}
						<ChartUi.Tooltip labelFormatter={(v) => xLabel.full(v)} />
					{/snippet}
				</AreaChart>
			{/if}
		</ChartUi.Container>
	{/if}
</div>

<BindDataDialog {element} bind:open={bindOpen} />
