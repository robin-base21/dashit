<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import { getDb } from '$lib/db/context';
	import { liveQuery } from '$lib/db/client.svelte';
	import { getDataflow } from '$lib/dataflow/engine.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	const db = getDb();
	const dataflow = getDataflow();

	const transformers = liveQuery(db, (d) => d.call('listTransformers'), ['transformers']);
	const edges = liveQuery(db, (d) => d.call('listEdges'), ['edges']);

	const inputCount = $derived.by(() => {
		const m = new Map<string, number>();
		for (const e of edges.value ?? []) {
			if (e.consumer_kind === 'transformer') m.set(e.consumer_id, (m.get(e.consumer_id) ?? 0) + 1);
		}
		return m;
	});
	const consumerCount = $derived.by(() => {
		const m = new Map<string, number>();
		for (const e of edges.value ?? []) {
			if (e.producer_kind === 'transformer') m.set(e.producer_id, (m.get(e.producer_id) ?? 0) + 1);
		}
		return m;
	});

	const DEFAULT_CODE = `// inputs[0], inputs[1], … are the bound sources, in order.\n// Return JSON-serialisable data for charts and aggregations.\nreturn inputs[0];\n`;

	async function create() {
		try {
			const { transformer_id } = await db.call('createTransformer', {
				name: `Transformer ${(transformers.value?.length ?? 0) + 1}`,
				code: DEFAULT_CODE,
				site_id: db.info?.siteId ?? '',
				note: 'created'
			});
			await goto(resolve('/(app)/transformers/[id]', { id: transformer_id }));
		} catch (e) {
			toast.error('Could not create transformer', { description: e instanceof Error ? e.message : String(e) });
		}
	}

	async function remove(id: string, name: string) {
		await db.call('deleteTransformer', id);
		toast(`Deleted “${name}”`);
	}

	function statusLabel(id: string) {
		const s = dataflow.get(`transformer:${id}`);
		return s.status;
	}
</script>

<svelte:head><title>Transformers · DashIt</title></svelte:head>

<div class="p-6">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Transformers</h1>
			<p class="text-sm text-muted-foreground">Your code, run in a sandbox, reshaping datasources into datasets.</p>
		</div>
		<Button onclick={create}>
			<PlusIcon class="size-4" />
			New transformer
		</Button>
	</div>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each transformers.value ?? [] as t (t.id)}
			{@const status = statusLabel(t.id)}
			<Card.Root data-transformer-id={t.id}>
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<a href={resolve('/(app)/transformers/[id]', { id: t.id })} class="truncate hover:underline">{t.name}</a>
						<Badge variant={status === 'error' ? 'destructive' : status === 'ok' ? 'outline' : 'secondary'}>{status}</Badge>
					</Card.Title>
					<Card.Description>
						{inputCount.get(t.id) ?? 0} inputs · {consumerCount.get(t.id) ?? 0} consumers · timeout {t.timeout_ms} ms
					</Card.Description>
					<Card.Action>
						<Button size="icon-sm" variant="ghost" aria-label="Delete transformer" onclick={() => remove(t.id, t.name)}>
							<Trash2Icon class="size-4" />
						</Button>
					</Card.Action>
				</Card.Header>
				<Card.Content>
					<Button variant="outline" size="sm" href={resolve('/(app)/transformers/[id]', { id: t.id })}>Open editor</Button>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No transformers yet.</p>
		{/each}
	</div>
</div>
