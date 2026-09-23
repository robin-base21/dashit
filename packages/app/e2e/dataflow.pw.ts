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

test('task list → internal datasource → aggregation updates live', async ({ page }) => {
	await page.goto('/dashboard');
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible({ timeout: 60_000 });
	const gb = (await grid.boundingBox())!;

	const list = await createAndPlace(page, 'Task list', 'Todo', { x: gb.x + 60, y: gb.y + 40 });
	for (const t of ['One', 'Two', 'Three']) {
		const input = list.getByLabel('New item');
		await input.fill(t);
		await input.press('Enter');
	}
	await expect(list.getByRole('treeitem')).toHaveCount(3);

	// Internal datasource from the task list.
	await page.getByRole('link', { name: 'Datasources' }).click();
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByRole('button', { name: 'Type', exact: true }).click();
	await page.getByRole('option', { name: 'Element data (internal)' }).click();
	await page.getByRole('button', { name: 'Element', exact: true }).click();
	await page.getByRole('option', { name: /Todo/ }).click();
	await page.getByLabel('Name').fill('Todo items');
	await page.getByRole('button', { name: 'Create' }).click();
	const dsCard = page.locator('[data-datasource-id]', { hasText: 'Todo items' });
	await expect(dsCard).toBeVisible();
	await expect(dsCard.getByText('3 records')).toBeVisible();
	await expect(dsCard.getByText('active')).toHaveCount(0); // nothing consumes it yet

	// Aggregation bound to it: count of done items.
	await page.getByRole('link', { name: 'Dashboard' }).click();
	await expect(grid).toBeVisible();
	const agg = await createAndPlace(page, 'Aggregation', 'Done count', { x: gb.x + 500, y: gb.y + 40 });
	await agg.getByRole('button', { name: 'Bind data' }).click();
	await page.getByRole('button', { name: 'Source', exact: true }).click();
	await page.getByRole('option', { name: 'Todo items' }).click();
	await page.getByRole('button', { name: 'Function', exact: true }).click();
	await page.getByRole('option', { name: 'sum' }).click();
	await page.getByRole('button', { name: 'Field', exact: true }).click();
	await page.getByRole('option', { name: 'done' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const value = agg.getByTestId('aggregation-value');
	await expect(value).toHaveText('0');

	// Ticking items updates the aggregation live.
	await list.getByRole('treeitem').filter({ hasText: 'One' }).getByRole('checkbox').click();
	await expect(value).toHaveText('1');
	await list.getByRole('treeitem').filter({ hasText: 'Two' }).getByRole('checkbox').click();
	await expect(value).toHaveText('2');

	// The datasource is now active because a visible element consumes it; hiding the aggregation deactivates it.
	await page.getByRole('link', { name: 'Datasources' }).click();
	await expect(page.locator('[data-datasource-id]', { hasText: 'Todo items' }).getByText('active')).toBeVisible();
	await page.getByRole('link', { name: 'Dashboard' }).click();
	const aggCard = grid.locator('article[data-element-id]', { hasText: 'Done count' });
	await aggCard.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Hide' }).click();
	await page.getByRole('link', { name: 'Datasources' }).click();
	await expect(page.locator('[data-datasource-id]', { hasText: 'Todo items' }).getByText('active')).toHaveCount(0);

	// Persistence: binding, config and value survive a reload after unhiding.
	await page.getByRole('link', { name: 'Dashboard' }).click();
	if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
		await page.getByRole('button', { name: 'Elements', exact: true }).click();
	}
	await page.getByRole('tab', { name: /Hidden/ }).click();
	const hidden = page.locator('aside [data-element-id]', { hasText: 'Done count' });
	await hidden.hover();
	await hidden.getByRole('button', { name: 'Show on dashboard' }).click();
	await page.reload();
	await expect(grid).toBeVisible({ timeout: 30_000 });
	await expect(grid.locator('article[data-element-id]', { hasText: 'Done count' }).getByTestId('aggregation-value')).toHaveText('2');
});
