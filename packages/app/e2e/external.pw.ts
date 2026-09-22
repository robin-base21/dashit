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

test('external datasource polls only while a visible chart consumes it', async ({ page }) => {
	let hits = 0;
	let seenAuth = '';
	await page.route('https://api.example.test/metrics', async (route) => {
		hits++;
		seenAuth = route.request().headers()['authorization'] ?? '';
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ data: { points: [{ t: 'a', v: hits }, { t: 'b', v: hits * 2 }, { t: 'c', v: 3 }] } })
		});
	});

	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByRole('button', { name: 'Type', exact: true }).click();
	await page.getByRole('option', { name: 'External API (HTTP polling)' }).click();
	await page.getByLabel('Name').fill('Metrics API');
	await page.getByLabel('URL').fill('https://api.example.test/metrics');
	await page.getByLabel('Poll every (seconds)').fill('5');
	await page.getByLabel('Response path').fill('data.points');
	await page.getByLabel(/Headers/).fill('Authorization: Bearer secret-token');
	await page.getByRole('button', { name: 'Create' }).click();

	// Nothing consumes it yet: inactive, no requests.
	const card = page.locator('[data-datasource-id]', { hasText: 'Metrics API' });
	await expect(card.getByTestId('preview')).toContainText('Inactive');
	await page.waitForTimeout(1500);
	expect(hits).toBe(0);

	// Manual fetch works even while inactive and sends the stored header.
	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect(card.getByTestId('preview')).toContainText('"t": "a"');
	expect(hits).toBe(1);
	expect(seenAuth).toBe('Bearer secret-token');

	// Bind a chart on the dashboard → source becomes active and polls every 5s.
	await page.getByRole('link', { name: 'Dashboard' }).click();
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible();
	const gb = (await grid.boundingBox())!;
	const chart = await createAndPlace(page, 'Chart', 'Metrics chart', { x: gb.x + 60, y: gb.y + 40 });
	await chart.getByRole('button', { name: 'Bind data' }).click();
	await page.getByRole('button', { name: 'Source', exact: true }).click();
	await page.getByRole('option', { name: 'Metrics API' }).click();
	await page.getByRole('button', { name: 'X field', exact: true }).click();
	await page.getByRole('option', { name: 't' }).click();
	await page.getByRole('checkbox', { name: 'v' }).click();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await expect(chart.getByTestId('chart').locator('svg').first()).toBeVisible();
	const before = hits;
	await expect.poll(() => hits, { timeout: 12_000 }).toBeGreaterThan(before + 0); // activation fetch + poll
	await expect.poll(() => hits, { timeout: 12_000 }).toBeGreaterThanOrEqual(before + 2);

	// Hide the chart → polling stops.
	await chart.getByRole('button', { name: 'Element actions' }).click();
	await page.getByRole('menuitem', { name: 'Hide' }).click();
	await expect(chart).toHaveCount(0);
	const atHide = hits;
	await page.waitForTimeout(7000);
	expect(hits).toBe(atHide);

	// The datasources page shows the last value as stale-but-present (no longer active).
	await page.getByRole('link', { name: 'Datasources' }).click();
	const again = page.locator('[data-datasource-id]', { hasText: 'Metrics API' });
	await expect(again.getByText('active')).toHaveCount(0);
	await expect(again.getByTestId('preview')).toContainText('"t": "a"');
});

test('a failing endpoint surfaces its error without breaking the page', async ({ page }) => {
	await page.route('https://api.example.test/broken', (route) =>
		route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'nope' })
	);
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByRole('button', { name: 'Type', exact: true }).click();
	await page.getByRole('option', { name: 'External API (HTTP polling)' }).click();
	await page.getByLabel('URL').fill('https://api.example.test/broken');
	await page.getByRole('button', { name: 'Create' }).click();
	const card = page.locator('[data-datasource-id]', { hasText: 'api.example.test' });
	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect(card.getByTestId('fetch-error')).toContainText('HTTP 500');
	await expect(card.getByTestId('preview')).toContainText('Error');
});
