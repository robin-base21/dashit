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

async function createAndPlace(page: Page, kind: string, title: string) {
	await page.goto('/dashboard');
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible({ timeout: 60_000 });
	const gb = (await grid.boundingBox())!;
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
	await page.mouse.move(gb.x + 60, gb.y + 40, { steps: 10 });
	await page.mouse.up();
	const card = grid.locator('article[data-element-id]', { hasText: title });
	await expect(card).toBeVisible();
	return card;
}

test('progress reads out a percentage, a ratio, and a fixed total', async ({ page }) => {
	// A boolean field sums as 1/0, so this is 2 of 3 done.
	await staticSource(page, 'Chores', [{ done: true }, { done: false }, { done: true }]);
	const card = await createAndPlace(page, 'Progress', 'Chore progress');

	await card.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', 'Chores');
	await pickOption(page, 'Value function', 'sum');
	await pickOption(page, 'Value field', 'done');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// Default total is the row count: 2 of 3.
	const readout = card.getByTestId('progress-value');
	await expect(readout).toHaveText('66.7%');
	// The bar is a real progressbar, not a styled div.
	await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /6[0-9]/);

	// Same numbers, shown as a ratio.
	await card.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Bind data' }).click();
	await pickOption(page, 'Show as', /Ratio/);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(readout).toHaveText('2 / 3');

	// A fixed denominator replaces the aggregated one.
	await card.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Bind data' }).click();
	await page.getByRole('checkbox', { name: 'Fixed total' }).click();
	await page.getByLabel('Total', { exact: true }).fill('10');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(readout).toHaveText('2 / 10');

	// Survives a reload.
	await page.reload();
	await expect(page.getByTestId('dashboard-grid').getByTestId('progress-value')).toHaveText('2 / 10');
});

test('the data format dialog shows the expected shape beside the live one', async ({ page }) => {
	await staticSource(page, 'Metrics', [{ t: 'a', cpu: 1 }, { t: 'b', cpu: 2 }]);
	const chart = await createAndPlace(page, 'Chart', 'CPU chart');

	await chart.getByRole('button', { name: 'Bind data' }).click();
	await pickOption(page, 'Source', 'Metrics');
	await pickOption(page, 'X field', 't');
	await page.getByRole('checkbox', { name: 'cpu' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await chart.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Data format' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('What a datasource or transformer must produce');
	await expect(dialog.getByTestId('schema-example')).toContainText('cpu');
	// The live half reflects the actual binding, not the example.
	await expect(dialog.getByTestId('schema-live-fields')).toContainText('t');
	await expect(dialog.getByTestId('schema-live-sample')).toContainText('"cpu": 1');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// An editable documents what it emits instead.
	const list = await createAndPlace(page, 'Task list', 'Chores list');
	await list.getByRole('textbox', { name: 'New item' }).fill('Buy milk');
	await list.getByRole('textbox', { name: 'New item' }).press('Enter');
	await list.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Data format' }).click();
	const taskDialog = page.getByRole('dialog');
	await expect(taskDialog).toContainText('What this element emits');
	await expect(taskDialog.getByTestId('schema-example')).toContainText('depth');
	await expect(taskDialog.getByTestId('schema-live-sample')).toContainText('Buy milk');
});
