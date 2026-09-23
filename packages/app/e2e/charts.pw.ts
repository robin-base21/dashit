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

// Pinned so the assertions do not depend on the machine running them: en-GB is 24-hour, and UTC
// makes the expected clock time equal the stored one.
test.use({ locale: 'en-GB', timezoneId: 'UTC' });

test('a long timestamp axis is thinned and localized, never raw ISO', async ({ page }) => {
	// 40 ISO timestamps a minute apart — what a tracked datasource stores. LayerChart draws a band
	// scale's whole domain unless given a tick count, and renders the value verbatim unless given a
	// format, so untreated this is 40 overlapping copies of "2026-09-23T09:00:00.000Z".
	const rows = Array.from({ length: 40 }, (_, i) => ({
		t: new Date(Date.UTC(2026, 8, 23, 9, i)).toISOString(),
		cpu: 40 + ((i * 7) % 30)
	}));

	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByLabel('Name').fill('Timeline');
	await page.getByLabel('JSON value').fill(JSON.stringify(rows));
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('40 records')).toBeVisible();

	await page.getByRole('link', { name: 'Dashboard' }).click();
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible();
	const gb = (await grid.boundingBox())!;

	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: /Chart/ }).click();
	await page.getByLabel('Title').fill('Timeline chart');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const handle = page.locator('aside [data-element-id]').getByRole('button', { name: 'Drag onto the dashboard' });
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + 8, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
	await page.mouse.move(gb.x + 60, gb.y + 40, { steps: 10 });
	await page.mouse.up();
	const card = grid.locator('article[data-element-id]', { hasText: 'Timeline chart' });
	await expect(card).toBeVisible();

	await card.getByRole('button', { name: 'Bind data' }).click();
	await page.getByRole('button', { name: 'Source', exact: true }).click();
	await page.getByRole('option', { name: 'Timeline' }).click();
	await page.getByRole('button', { name: 'X field', exact: true }).click();
	await page.getByRole('option', { name: 't', exact: true }).click();
	await page.getByRole('checkbox', { name: 'cpu' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const chart = card.getByTestId('chart');
	// A minute apart and inside one day, so the axis needs neither seconds nor the date.
	const timeLabels = chart.locator('text').filter({ hasText: /^\d{2}:\d{2}$/ });
	await expect(chart.locator('svg').first()).toBeVisible();

	// The data is all still plotted; only the labels are thinned.
	for (const type of ['bar', 'line', 'area'] as const) {
		if (type !== 'bar') {
			await card.getByRole('button', { name: 'Element actions' }).click();
			await page.getByRole('menuitem', { name: 'Bind data' }).click();
			await page.getByRole('button', { name: 'Chart type' }).click();
			await page.getByRole('option', { name: type === 'line' ? 'Line' : 'Area' }).click();
			await page.getByRole('button', { name: 'Save' }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
		}
		await expect(chart).toHaveAttribute('data-chart-type', type);
		const shown = await timeLabels.count();
		expect(shown, `${type}: ${shown} of 40 labels drawn`).toBeGreaterThan(0);
		expect(shown, `${type}: ${shown} of 40 labels drawn`).toBeLessThanOrEqual(5);

		// Nothing raw leaks through: no ISO separators anywhere on the axis.
		const axisText = await chart.locator('text').allInnerTexts();
		expect(axisText.join(' '), `${type} axis shows a raw ISO string`).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:|Z$/);
	}

	// The tooltip carries the date that the axis drops.
	const chartBox = (await chart.boundingBox())!;
	await page.mouse.move(chartBox.x + chartBox.width * 0.5, chartBox.y + chartBox.height * 0.5);
	await expect(page.locator('text=/23 Sept|Sept 23|23 Sep/').first()).toBeVisible({ timeout: 5_000 });
});
