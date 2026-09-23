import { expect, test, type Page } from '@playwright/test';
import type { SpikeReport } from '../src/routes/spike/spike.worker.ts';
import type { RunResult } from '../src/lib/sandbox/sandbox.ts';

interface SpikeWindow {
	db: SpikeReport | null;
	sandbox: Record<string, RunResult> | null;
	error: string | null;
}

async function runSpike(page: Page, reset = false): Promise<SpikeWindow> {
	page.on('console', (m) => { if (m.text().startsWith('[spike]') || m.type() === 'error') console.log(`[${m.type()}] ${m.text()}`); });
	await page.goto(reset ? '/spike?reset' : '/spike');
	await page.waitForSelector('main[data-done="true"]', { timeout: 120_000 });
	return page.evaluate(() => (window as unknown as { __spike: SpikeWindow }).__spike);
}

test('cr-sqlite persistence, merge, and sandbox egress', async ({ page, browserName }) => {
	const first = await runSpike(page, true);
	test.info().annotations.push({ type: 'first-run', description: JSON.stringify(first, null, 2) });
	console.log(`\n[${browserName}] first run\n` + JSON.stringify(first, null, 2));

	expect(first.error).toBeNull();
	expect(first.db?.merge.ok, first.db?.merge.error).toBe(true);

	// Migration v4 alters a live CRR table — the one path no unit test can reach.
	const alter = first.db!.alter;
	expect(alter.error).toBeUndefined();
	expect(alter.columns?.sort()).toEqual(['track_key', 'track_limit', 'track_mode']);
	expect(alter.trackModeOnB, 'altered column lost its cr-sqlite change tracking').toBe('sample');
	expect(alter.sampleChanges, 'datasource_samples must stay out of the changeset feed').toBe(0);

	for (const v of first.db!.vfs) {
		if (!v.supported) continue;
		expect(v.error, `${v.vfs}: ${v.error}`).toBeUndefined();
		expect(v.cellsAfter).toBe(10_000);
	}

	// Persistence: reload and expect the marker and rows to survive.
	const second = await runSpike(page);
	console.log(`\n[${browserName}] second run\n` + JSON.stringify(second.db?.vfs, null, 2));
	for (const [i, v] of second.db!.vfs.entries()) {
		if (!v.supported) continue;
		expect(v.error, `${v.vfs}: ${v.error}`).toBeUndefined();
		expect(v.markerBefore, `${v.vfs} marker did not persist`).toBe(first.db!.vfs[i]!.markerAfter!);
		expect(v.cellsBefore, `${v.vfs} rows did not persist`).toBe(10_000);
	}

	// Sandbox
	const sb = first.sandbox!;
	expect(sb.probes.ok).toBe(true);
	const probes = (sb.probes as Extract<RunResult, { ok: true }>).output as Record<string, string>;
	for (const [name, outcome] of Object.entries(probes)) {
		expect(outcome, `${name} was not blocked`).toMatch(/^blocked:/);
	}
	expect(sb.echo).toMatchObject({ ok: true, output: [2, 4, 6] });
	expect(sb.loop).toMatchObject({ ok: false, error: { name: 'TimeoutError' } });
	expect(sb.throws).toMatchObject({ ok: false, error: { name: 'TypeError', message: 'boom' } });
	expect(sb.cyclic.ok).toBe(false);
});
