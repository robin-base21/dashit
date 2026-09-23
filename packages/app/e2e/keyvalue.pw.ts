import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers.ts';

async function staticSource(page: Page, name: string, value: unknown) {
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByLabel('Name').fill(name);
	await page.getByLabel('JSON value').fill(JSON.stringify(value));
	const create = page.getByRole('button', { name: 'Create' });
	await create.scrollIntoViewIfNeeded();
	await create.click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function createAndPlace(page: Page, kind: string, title: string, at: { x: number; y: number }) {
	await page.goto('/dashboard');
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible({ timeout: 60_000 });
	if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
		await page.getByRole('button', { name: 'Elements', exact: true }).click();
	}
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: new RegExp(kind) }).click();
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const handle = page
		.locator('aside [data-element-id]', { hasText: title })
		.getByRole('button', { name: 'Drag onto the dashboard' });
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + 8, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
	await page.mouse.move(at.x, at.y, { steps: 10 });
	await page.mouse.up();
	const card = grid.locator('article[data-element-id]', { hasText: title });
	await expect(card).toBeVisible();
	return card;
}

test('a flat object renders as rows with no configuration at all', async ({ page }) => {
	await staticSource(page, 'Status', { cpu: 42, memory: 61.4, healthy: true, checked: null });
	const grid = page.getByTestId('dashboard-grid');
	await page.goto('/dashboard');
	const gb = (await grid.boundingBox())!;
	const card = await createAndPlace(page, 'Key/value list', 'Status list', { x: gb.x + 60, y: gb.y + 40 });

	// Only the source is chosen; the label and value stay on Auto.
	await card.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', 'Status');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const rows = card.getByTestId('keyvalue-rows');
	await expect(rows.locator('[data-kv-key]')).toHaveCount(4);
	// Types are inferred: a boolean reads as a word, an absent value as a dash.
	await expect(rows.locator('[data-kv-key="healthy"]')).toContainText('Yes');
	await expect(rows.locator('[data-kv-key="checked"]')).toContainText('—');
	await expect(rows.locator('[data-kv-key="cpu"]')).toContainText('42');

	// Survives a reload, so the config really was persisted.
	await page.reload();
	await expect(page.getByTestId('keyvalue-rows').locator('[data-kv-key]')).toHaveCount(4);
});

test('the metric field formats each row by its own unit', async ({ page }) => {
	await staticSource(page, 'Readings', [
		{ name: 'Latency', v: 1240, u: 'ms' },
		{ name: 'Payload', v: 1536, u: 'bytes' },
		{ name: 'Success', v: 0.985, u: '%' },
		{ name: 'Throughput', v: 1240, u: 'rpm' }
	]);
	const grid = page.getByTestId('dashboard-grid');
	await page.goto('/dashboard');
	const gb = (await grid.boundingBox())!;
	const card = await createAndPlace(page, 'Key/value list', 'Readings list', { x: gb.x + 60, y: gb.y + 40 });

	await card.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', 'Readings');

	// Several records with nothing chosen cannot be laid out, so the view asks for the fields.
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(card).toContainText('Pick the label and value fields');

	await card.getByRole('button', { name: 'Configure' }).click();
	await pickOption(page, 'Label field', 'name');
	await pickOption(page, 'Value field', 'v');
	await pickOption(page, 'Metric field', 'u');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const rows = card.getByTestId('keyvalue-rows');
	await expect(rows.locator('[data-kv-key="Latency"]')).toContainText('1.24 s');
	await expect(rows.locator('[data-kv-key="Payload"]')).toContainText('1.5 KB');
	await expect(rows.locator('[data-kv-key="Success"]')).toContainText('98.5%');
	// An unknown unit is appended rather than dropped.
	await expect(rows.locator('[data-kv-key="Throughput"]')).toContainText('rpm');
});
