import { expect, test, type Page } from '@playwright/test';

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

	await page.getByRole('button', { name: 'Add input' }).click();
	await page.getByRole('option', { name: /Raw/ }).click();
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
	await page.getByRole('button', { name: 'Source', exact: true }).click();
	await page.getByRole('option', { name: 'Transformer 1' }).click();
	await page.getByRole('button', { name: 'X field', exact: true }).click();
	await page.getByRole('option', { name: 'city' }).click();
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
