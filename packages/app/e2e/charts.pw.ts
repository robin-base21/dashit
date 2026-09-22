import { expect, test } from '@playwright/test';

const TYPES = ['Bar', 'Line', 'Area', 'Pie', 'Radar', 'Radial'] as const;

test('every chart type renders from a static datasource and re-renders on config change', async ({ page }) => {
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByLabel('Name').fill('Sales');
	await page.getByLabel('JSON value').fill(
		JSON.stringify([
			{ month: 'Jan', desktop: 186, mobile: 80 },
			{ month: 'Feb', desktop: 305, mobile: 200 },
			{ month: 'Mar', desktop: 237, mobile: 120 }
		])
	);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('3 records')).toBeVisible();

	await page.getByRole('link', { name: 'Dashboard' }).click();
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible();
	const gb = (await grid.boundingBox())!;

	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: /Chart/ }).click();
	await page.getByLabel('Title').fill('Sales chart');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const handle = page.locator('aside [data-element-id]').getByRole('button', { name: 'Drag onto the dashboard' });
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + 8, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
	await page.mouse.move(gb.x + 60, gb.y + 40, { steps: 10 });
	await page.mouse.up();
	const card = grid.locator('article[data-element-id]', { hasText: 'Sales chart' });
	await expect(card).toBeVisible();

	// Unbound state offers "Bind data".
	await card.getByRole('button', { name: 'Bind data' }).click();
	await page.getByRole('button', { name: 'Source', exact: true }).click();
	await page.getByRole('option', { name: 'Sales' }).click();
	await page.getByRole('button', { name: 'X field', exact: true }).click();
	await page.getByRole('option', { name: 'month' }).click();
	await page.getByRole('checkbox', { name: 'desktop' }).click();
	await page.getByRole('checkbox', { name: 'mobile' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const chart = card.getByTestId('chart');
	await expect(chart).toHaveAttribute('data-chart-type', 'bar');
	await expect(chart.locator('svg').first()).toBeVisible();
	await expect(chart.locator('text').filter({ hasText: /^Feb$/ })).toHaveCount(1);
	// 3 months × 2 series = 6 bars
	await expect(chart.locator('.lc-bar, [class*="lc-bar"] rect, rect.lc-bar').first()).toBeVisible();

	// Switch through every other type via the config dialog; each must render an svg.
	for (const t of TYPES.slice(1)) {
		await card.getByRole('button', { name: 'Element actions' }).click();
		await page.getByRole('menuitem', { name: 'Bind data…' }).click();
		await page.getByRole('button', { name: 'Chart type', exact: true }).click();
		await page.getByRole('option', { name: t, exact: true }).click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(chart).toHaveAttribute('data-chart-type', t.toLowerCase());
		await expect(chart.locator('svg').first()).toBeVisible();
		await expect(chart.locator('svg path.lc-path').first()).toBeAttached();
	}

	// Reload keeps the configuration.
	await page.reload();
	await expect(grid).toBeVisible({ timeout: 30_000 });
	await expect(grid.locator('article[data-element-id]', { hasText: 'Sales chart' }).getByTestId('chart')).toHaveAttribute('data-chart-type', 'radial');
});
