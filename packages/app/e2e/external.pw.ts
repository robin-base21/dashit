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
	await pickOption(page, 'Type', 'External API (HTTP polling)');
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
	await pickOption(page, 'Source', 'Metrics API');
	await pickOption(page, 'X field', 't');
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
	await pickOption(page, 'Type', 'External API (HTTP polling)');
	await page.getByLabel('URL').fill('https://api.example.test/broken');
	await page.getByRole('button', { name: 'Create' }).click();
	const card = page.locator('[data-datasource-id]', { hasText: 'api.example.test' });
	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect(card.getByTestId('fetch-error')).toContainText('HTTP 500');
	await expect(card.getByTestId('preview')).toContainText('Error');
});

test('POST datasources send a JSON or text body; a Content-Type header overrides the default', async ({ page }) => {
	const seen: { method: string; contentType: string; body: string | null; token: string }[] = [];
	await page.route('https://api.example.test/graphql', async (route) => {
		const req = route.request();
		seen.push({
			method: req.method(),
			contentType: req.headers()['content-type'] ?? '',
			body: req.postData(),
			token: req.headers()['x-token'] ?? ''
		});
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ data: { items: [{ id: 1 }, { id: 2 }] } })
		});
	});

	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await pickOption(page, 'Type', 'External API (HTTP polling)');

	// GET shows no body section.
	await expect(page.getByTestId('body-section')).toHaveCount(0);
	await pickOption(page, 'Method', 'POST');
	await expect(page.getByTestId('body-section')).toBeVisible();

	await page.getByLabel('Name').fill('GraphQL');
	await page.getByLabel('URL').fill('https://api.example.test/graphql');
	await page.getByLabel('Response path').fill('data.items');
	await page.getByLabel(/Headers/).fill('X-Token: t');

	// Invalid JSON is rejected before saving.
	await page.getByLabel('Body', { exact: true }).fill('{ not json');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText(/not valid JSON/)).toBeVisible();
	await expect(page.getByRole('dialog')).toBeVisible();

	await page.getByLabel('Body', { exact: true }).fill('{"query":"{ items { id } }"}');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	const card = page.locator('[data-datasource-id]', { hasText: 'GraphQL' });
	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect(card.getByTestId('preview')).toContainText('"id": 1');
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({ method: 'POST', contentType: 'application/json', token: 't' });
	expect(JSON.parse(seen[0]!.body!)).toEqual({ query: '{ items { id } }' });

	// Edit → text body with an explicit Content-Type header; the header wins and the body is kept verbatim.
	await card.getByRole('button', { name: 'Edit datasource' }).click();
	await expect(page.getByLabel('Body', { exact: true })).toHaveValue('{"query":"{ items { id } }"}');
	await pickOption(page, 'Body type', 'Text');
	await page.getByLabel('Body', { exact: true }).fill('id,name\n1,a');
	await page.getByLabel(/Headers/).fill('X-Token: t2\nContent-Type: text/csv');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect.poll(() => seen.length).toBe(2);
	expect(seen[1]).toMatchObject({ method: 'POST', contentType: 'text/csv', body: 'id,name\n1,a', token: 't2' });
});
