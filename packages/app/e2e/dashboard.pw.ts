import { expect, test, type Page } from '@playwright/test';

async function resetDb(page: Page) {
	// Fresh database per test: wipe OPFS + IndexedDB for the origin, then reload.
	await page.goto('/dashboard');
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 60_000 });
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory().catch(() => null);
		if (root) {
			for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
				await root.removeEntry(name, { recursive: true }).catch(() => {});
			}
		}
		const dbs = (await indexedDB.databases?.()) ?? [];
		await Promise.all(
			dbs.map((d) => d.name && new Promise((res) => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(null); }))
		);
	});
	await page.reload();
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 30_000 });
}

async function dragTo(page: Page, sourceSelector: string, target: { x: number; y: number }) {
	const handle = page.locator(sourceSelector);
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 30, box.y + 30, { steps: 3 });
	await page.mouse.move(target.x, target.y, { steps: 12 });
	await page.mouse.up();
}

test('create, place, move, hide, unhide, delete, and persist', async ({ page }) => {
	await resetDb(page);

	// Create a task list from the elements panel.
	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: /Task list/ }).click();
	await page.getByLabel('Title').fill('Groceries');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const panelItem = page.locator('aside [data-element-id]', { hasText: 'Groceries' });
	await expect(panelItem).toBeVisible();

	// Drag it onto the grid.
	const grid = page.getByTestId('dashboard-grid');
	const gb = (await grid.boundingBox())!;
	await dragTo(page, 'aside [data-element-id] button[aria-label="Drag onto the dashboard"]', { x: gb.x + 60, y: gb.y + 40 });

	const card = grid.locator('article[data-element-id]', { hasText: 'Groceries' });
	await expect(card).toBeVisible();
	await expect(panelItem).toHaveCount(0);

	// Move it to the right; the card should end up further right.
	const before = (await card.boundingBox())!;
	await dragTo(page, 'article[data-element-id] button[aria-label="Move"]', { x: gb.x + gb.width - 80, y: gb.y + 40 });
	await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(before.x + 100);

	// Resize taller.
	const beforeResize = (await card.boundingBox())!;
	const resize = card.getByRole('button', { name: 'Resize' });
	const rb = (await resize.boundingBox())!;
	await page.mouse.move(rb.x + 4, rb.y + 4);
	await page.mouse.down();
	await page.mouse.move(rb.x + 4, rb.y + 200, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(beforeResize.height + 50);

	// Hide → appears under Hidden; unhide → back on the grid.
	await card.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Hide' }).click();
	await expect(card).toHaveCount(0);
	await page.getByRole('tab', { name: /Hidden/ }).click();
	const hiddenItem = page.locator('aside [data-element-id]', { hasText: 'Groceries' });
	await expect(hiddenItem).toBeVisible();
	await hiddenItem.hover();
	await hiddenItem.getByRole('button', { name: 'Show on dashboard' }).click();
	await expect(card).toBeVisible();

	// Persistence across reload.
	await page.reload();
	await expect(grid.locator('article[data-element-id]', { hasText: 'Groceries' })).toBeVisible();

	// Delete.
	const again = grid.locator('article[data-element-id]', { hasText: 'Groceries' });
	await again.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await expect(again).toHaveCount(0);
	await expect(page.getByText('Your dashboard is empty')).toBeVisible();

	await page.screenshot({ path: 'test-results/dashboard-final.png' });
});

test('the elements panel and cards separate editables from observables', async ({ page }) => {
	await resetDb(page);
	await page.getByRole('button', { name: 'Elements', exact: true }).click();

	for (const [kind, title] of [
		['Task list', 'Chores'],
		['Chart', 'Revenue']
	]) {
		await page.getByRole('button', { name: 'New' }).click();
		await page.getByRole('radio', { name: new RegExp(kind!) }).click();
		await page.getByLabel('Title').fill(title!);
		await page.getByRole('button', { name: 'Create' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}

	// Both categories get their own labelled section, in that order.
	const panel = page.locator('aside[aria-label="Elements"]');
	await expect(panel.getByRole('heading', { level: 3 })).toHaveText([/Editable\s*1/, /Observable\s*1/]);
	await expect(panel.locator('[data-element-id]', { hasText: 'Chores' })).toHaveAttribute('data-category', 'editable');
	await expect(panel.locator('[data-element-id]', { hasText: 'Revenue' })).toHaveAttribute(
		'data-category',
		'observable'
	);

	// The distinction survives onto the dashboard.
	const grid = page.getByTestId('dashboard-grid');
	const gb = (await grid.boundingBox())!;
	await dragTo(page, 'aside [data-element-id]:has-text("Revenue") button[aria-label="Drag onto the dashboard"]', {
		x: gb.x + 60,
		y: gb.y + 40
	});
	await expect(grid.locator('article[data-element-id]', { hasText: 'Revenue' })).toHaveAttribute(
		'data-category',
		'observable'
	);
});
