import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers.ts';

async function createAndPlace(page: Page, kind: string, title: string, at: { x: number; y: number }) {
	if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
		await page.getByRole('button', { name: 'Elements', exact: true }).click();
	}
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: new RegExp(kind) }).click();
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const handle = page.locator('aside [data-element-id]', { hasText: title }).getByRole('button', { name: 'Drag onto the dashboard' });
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + 8, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
	await page.mouse.move(at.x, at.y, { steps: 10 });
	await page.mouse.up();
	const card = page.getByTestId('dashboard-grid').locator('article[data-element-id]', { hasText: title });
	await expect(card).toBeVisible();
	return card;
}

test('transformer reshapes a datasource, feeds a chart, and keeps versions', async ({ page }) => {
	// Static datasource with raw rows.
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByLabel('Name').fill('Raw');
	await page.getByLabel('JSON value').fill(JSON.stringify([{ city: 'Oslo', c: 12 }, { city: 'Rome', c: 27 }, { city: 'Oslo', c: 8 }]));
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('3 records')).toBeVisible();

	// New transformer → editor.
	await page.getByRole('link', { name: 'Transformers' }).click();
	await page.getByRole('button', { name: 'New transformer' }).click();
	await expect(page).toHaveURL(/\/transformers\/[0-9a-f-]+$/, { timeout: 30_000 });
	await expect(page.getByLabel('Name')).toHaveValue('Transformer 1');

	await pickOption(page, 'Add input', /Raw/);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('[data-input-index="0"]')).toContainText('Raw');

	// Default code passes input through; run shows the raw rows.
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByTestId('run-output')).toContainText('"city": "Oslo"');

	// Group by city, sum c; the draft is dirty until saved.
	const code = page.locator('#t-code');
	await code.fill(`const totals = {};
for (const r of inputs[0]) totals[r.city] = (totals[r.city] ?? 0) + r.c;
return Object.entries(totals).map(([city, total]) => ({ city, total }));`);
	await expect(page.getByText('unsaved')).toBeVisible();
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByTestId('run-output')).toContainText('"total": 20');
	await page.getByRole('button', { name: 'Save version' }).click();
	await expect(page.getByText('unsaved')).toHaveCount(0);
	await expect(page.locator('[data-version-id]')).toHaveCount(2);
	await page.getByRole('tab', { name: 'Live output' }).click();
	await expect(page.getByTestId('live-output')).toContainText('"total": 20');

	// A chart bound to the transformer renders the grouped output.
	await page.getByRole('link', { name: 'Dashboard' }).click();
	const grid = page.getByTestId('dashboard-grid');
	const gb = (await grid.boundingBox())!;
	const chart = await createAndPlace(page, 'Chart', 'Totals', { x: gb.x + 60, y: gb.y + 40 });
	await chart.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', 'Transformer 1');
	await pickOption(page, 'X field', 'city');
	await page.getByRole('checkbox', { name: 'total' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(chart.getByTestId('chart').locator('svg').first()).toBeVisible();
	// Two grouped bars (Oslo, Rome), not three raw rows.
	await expect(chart.locator('text').filter({ hasText: /^Oslo$/ })).toHaveCount(1);
	await expect(chart.locator('text').filter({ hasText: /^Rome$/ })).toHaveCount(1);

	// Errors in code surface in the live status; restoring the old version recovers.
	await page.getByRole('link', { name: 'Transformers' }).click();
	await page.getByRole('link', { name: 'Transformer 1' }).click();
	await page.locator('#t-code').fill('throw new Error("boom")');
	await page.getByRole('button', { name: 'Save version' }).click();
	await expect(page.getByText('live: error')).toBeVisible();
	const versions = page.locator('[data-version-id]');
	await expect(versions).toHaveCount(3);
	await versions.nth(1).getByRole('button', { name: 'Restore' }).click();
	await expect(page.getByText('live: ok')).toBeVisible();
	await expect(page.locator('#t-code')).toHaveValue(/totals/);
});

test('a re-running transformer does not make its consumers rewind', async ({ page }) => {
	// A transformer holds its previous output while it re-runs. If a consumer treats that moment as
	// "no data", a progress bar animates back to zero and a chart re-animates on every upstream
	// tick. The busy-wait widens that window to ~300ms so the rewind is observable if it happens.
	let n = 2;
	await page.route('https://api.example.test/quota', async (route) => {
		n += 1;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ done: n, total: 10 })
		});
	});

	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await pickOption(page, 'Type', 'External API (HTTP polling)');
	await page.getByLabel('Name').fill('Quota');
	await page.getByLabel('URL').fill('https://api.example.test/quota');
	await page.getByLabel('Poll every (seconds)').fill('5');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await page.getByRole('link', { name: 'Transformers' }).click();
	await page.getByRole('button', { name: 'New transformer' }).click();
	await expect(page).toHaveURL(/\/transformers\/[0-9a-f-]+$/, { timeout: 30_000 });
	await pickOption(page, 'Add input', /Quota/);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.locator('#t-code').fill(`const end = Date.now() + 300;
while (Date.now() < end) {} // widen the running window
const q = inputs[0];
return [{ label: 'quota', done: q.done, total: q.total }];`);
	await page.getByRole('button', { name: 'Save version' }).click();
	await expect(page.getByText('unsaved')).toHaveCount(0);

	await page.getByRole('link', { name: 'Dashboard' }).click();
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible();
	const gb = (await grid.boundingBox())!;

	// The source only starts polling once something visible consumes it, so bind first and let a
	// value arrive — the field pickers are built from the producer's actual output.
	const bar = await createAndPlace(page, 'Progress', 'Quota used', { x: gb.x + 60, y: gb.y + 40 });
	await bar.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', /Transformer 1/);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(bar.getByTestId('progress-value')).not.toHaveText('—', { timeout: 30_000 });

	await bar.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Bind data' }).click();
	await pickOption(page, 'Value function', 'sum');
	await pickOption(page, 'Value field', 'done');
	await page.getByRole('checkbox', { name: 'Fixed total' }).click();
	await page.getByLabel('Total', { exact: true }).fill('10');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const chart = await createAndPlace(page, 'Chart', 'Quota chart', { x: gb.x + 500, y: gb.y + 40 });
	await chart.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', /Transformer 1/);
	await pickOption(page, 'X field', 'label');
	await page.getByRole('checkbox', { name: 'done' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// Wait for a first real value, so the initial empty render is not counted as a rewind.
	await expect
		.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow')), { timeout: 30_000 })
		.toBeGreaterThan(0);

	// Observe rather than poll: the running window is short, and a sampler can step over it.
	await page.evaluate(() => {
		const w = window as unknown as { __seen: { bar: number[]; label: string[]; chartBlank: number } };
		w.__seen = { bar: [], label: [], chartBlank: 0 };
		const progress = document.querySelector('[data-testid="progress"]')!;
		const chartEl = document.querySelector('[data-testid="chart"]')!;
		const record = () => {
			const el = progress.querySelector('[role="progressbar"]');
			if (el) w.__seen.bar.push(Number(el.getAttribute('aria-valuenow')));
			const label = progress.querySelector('[data-testid="progress-value"]');
			if (label) w.__seen.label.push((label.textContent ?? '').trim());
			if ((chartEl.textContent ?? '').includes('No data yet')) w.__seen.chartBlank += 1;
		};
		record();
		const opts = { attributes: true, childList: true, characterData: true, subtree: true };
		new MutationObserver(record).observe(progress, opts);
		new MutationObserver(record).observe(chartEl, opts);
	});

	// Long enough for at least two polls at the 5s minimum, so several re-runs are observed.
	await page.waitForTimeout(13_000);

	const seen = await page.evaluate(
		() => (window as unknown as { __seen: { bar: number[]; label: string[]; chartBlank: number } }).__seen
	);

	// It really did update — otherwise "never rewound" would pass on a frozen view.
	expect(new Set(seen.bar).size, `bar never changed: ${JSON.stringify(seen.bar)}`).toBeGreaterThan(1);
	// …and never rewound to empty on the way.
	expect(seen.bar, `bar rewound to 0: ${JSON.stringify(seen.bar)}`).not.toContain(0);
	expect(seen.label, `label blanked: ${JSON.stringify(seen.label)}`).not.toContain('—');
	expect(seen.chartBlank, 'chart fell back to "No data yet." mid-update').toBe(0);
});
