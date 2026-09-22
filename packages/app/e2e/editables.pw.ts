import { expect, test, type Page } from '@playwright/test';

async function fresh(page: Page) {
	await page.goto('/dashboard');
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 60_000 });
}

async function createAndPlace(page: Page, kind: string, title: string, at: { x: number; y: number }) {
	if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
		await page.getByRole('button', { name: 'Elements', exact: true }).click();
	}
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: new RegExp(kind) }).click();
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const item = page.locator('aside [data-element-id]', { hasText: title });
	const handle = item.getByRole('button', { name: 'Drag onto the dashboard' });
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

test('checklist items with a nested sub-task', async ({ page }) => {
	await fresh(page);
	const gb = (await page.getByTestId('dashboard-grid').boundingBox())!;
	const card = await createAndPlace(page, 'Checklist', 'Chores', { x: gb.x + 60, y: gb.y + 40 });

	const input = card.getByLabel('New item');
	await input.fill('Laundry');
	await input.press('Enter');
	await input.fill('Dishes');
	await input.press('Enter');
	await expect(card.getByRole('treeitem')).toHaveCount(2);

	// Tick one; the counter reflects it.
	const laundry = card.getByRole('treeitem').filter({ hasText: 'Laundry' });
	await laundry.getByRole('checkbox').click();
	await expect(card.getByText('1/2')).toBeVisible();

	// Nest a sub-task under Dishes.
	const dishes = card.getByRole('treeitem').filter({ hasText: 'Dishes' }).first();
	await dishes.hover();
	await dishes.getByRole('button', { name: 'Add sub-task' }).click();
	const sub = card.getByLabel('New sub-task');
	await sub.fill('Dry them');
	await sub.press('Enter');
	await expect(card.getByRole('treeitem').filter({ hasText: 'Dry them' }).last()).toBeVisible();
	await expect(card.getByText('1/3')).toBeVisible();

	// Rename via click-to-edit.
	await card.getByRole('button', { name: 'Laundry' }).click();
	const edit = card.locator('input:focus');
	await edit.fill('Laundry (whites)');
	await edit.press('Enter');
	await expect(card.getByText('Laundry (whites)')).toBeVisible();

	// Reload: everything persists.
	await page.reload();
	const again = page.getByTestId('dashboard-grid').locator('article[data-element-id]', { hasText: 'Chores' });
	await expect(again).toBeVisible({ timeout: 30_000 });
	await expect(again.getByText('1/3')).toBeVisible();
});

test('table with typed columns, rows and cells', async ({ page }) => {
	await fresh(page);
	const gb = (await page.getByTestId('dashboard-grid').boundingBox())!;
	const card = await createAndPlace(page, 'Table', 'Expenses', { x: gb.x + 500, y: gb.y + 40 });

	await card.getByRole('button', { name: 'Add column' }).click();
	await card.getByRole('button', { name: 'Add column' }).click();
	await expect(card.getByRole('columnheader')).toHaveCount(3); // 2 columns + add-column header

	// Rename first column and make the second numeric.
	await card.getByRole('button', { name: 'Column 1' }).dblclick();
	const rename = card.locator('thead input');
	await rename.fill('Item');
	await rename.press('Enter');
	await expect(card.getByRole('button', { name: 'Item' })).toBeVisible();

	const col2 = card.getByRole('columnheader').nth(1);
	await col2.hover();
	await col2.getByRole('button', { name: 'Column options' }).click();
	await page.getByRole('menuitem', { name: /Type:/ }).hover();
	await page.getByRole('menuitemcheckbox', { name: 'Number' }).click();

	await card.getByRole('button', { name: 'Add row' }).click();
	await card.getByRole('button', { name: 'Add row' }).click();
	await expect(card.locator('tbody tr')).toHaveCount(2);

	const firstRow = card.locator('tbody tr').first();
	const cells = firstRow.getByLabel('Value');
	await cells.nth(0).fill('Coffee');
	await cells.nth(0).press('Enter');
	await cells.nth(1).fill('4.5');
	await cells.nth(1).press('Enter');
	await expect(cells.nth(1)).toHaveAttribute('type', 'number');

	await page.reload();
	const again = page.getByTestId('dashboard-grid').locator('article[data-element-id]', { hasText: 'Expenses' });
	await expect(again).toBeVisible({ timeout: 30_000 });
	await expect(again.locator('tbody tr').first().getByLabel('Value').nth(0)).toHaveValue('Coffee');
	await expect(again.locator('tbody tr').first().getByLabel('Value').nth(1)).toHaveValue('4.5');
	await expect(again.getByText('2 rows')).toBeVisible();
});
