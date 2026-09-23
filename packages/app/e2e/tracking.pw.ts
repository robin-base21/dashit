import { expect, test, type Page } from '@playwright/test';

/**
 * Rows the datasource currently yields, read off its card. For a tracked source the dataflow node
 * value *is* the stored history, so this is the sample count as the user sees it.
 */
async function sampleCount(page: Page, name: string): Promise<number> {
	const count = page.locator('[data-datasource-id]', { hasText: name }).getByTestId('record-count');
	if ((await count.count()) === 0) return 0;
	return Number((await count.first().innerText()).trim());
}

/** The rows themselves, parsed out of the card's JSON preview. */
async function sampleRows(page: Page, name: string): Promise<Record<string, unknown>[]> {
	const text = await page.locator('[data-datasource-id]', { hasText: name }).getByTestId('preview').innerText();
	return JSON.parse(text) as Record<string, unknown>[];
}

async function newExternal(page: Page, fields: { name: string; url: string; path?: string }) {
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByRole('button', { name: 'Type', exact: true }).click();
	await page.getByRole('option', { name: 'External API (HTTP polling)' }).click();
	await page.getByLabel('Name').fill(fields.name);
	await page.getByLabel('URL').fill(fields.url);
	await page.getByLabel('Poll every (seconds)').fill('5');
	if (fields.path) await page.getByLabel('Response path').fill(fields.path);
}

test('sample mode turns a single current value into a series', async ({ page }) => {
	let hits = 0;
	await page.route('https://api.example.test/now', async (route) => {
		hits++;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ cpu: hits * 10 })
		});
	});

	await newExternal(page, { name: 'Now API', url: 'https://api.example.test/now' });
	await page.getByLabel('History').click();
	await page.getByRole('option', { name: 'Record each fetch' }).click();
	await page.getByLabel('Keep last').fill('4');
	await page.getByRole('button', { name: 'Create' }).click();

	const card = page.locator('[data-datasource-id]', { hasText: 'Now API' });
	await expect(card.getByTestId('tracked-badge')).toBeVisible();

	// Tracked sources poll with nothing on the dashboard consuming them — that is the point.
	await expect.poll(() => sampleCount(page, 'Now API'), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

	// Each fetch is its own row, stamped and flattened, rather than replacing the last.
	const rows = await sampleRows(page, 'Now API');
	expect(rows[0]).toHaveProperty('sampled_at');
	expect(new Set(rows.map((r) => r.cpu)).size).toBe(rows.length);

	// Eviction holds the line even as polling continues.
	await expect.poll(() => sampleCount(page, 'Now API'), { timeout: 30_000 }).toBeLessThanOrEqual(4);
});

test('merge mode grows the series past the window the API returns', async ({ page }) => {
	// A three-point window that slides by one on every request — the API never shows more than 3.
	let poll = 0;
	await page.route('https://api.example.test/series', async (route) => {
		const points = [0, 1, 2].map((i) => ({ t: `p${poll + i}`, v: poll + i }));
		poll++;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ data: points })
		});
	});

	await newExternal(page, { name: 'Series API', url: 'https://api.example.test/series', path: 'data' });
	await page.getByLabel('History').click();
	await page.getByRole('option', { name: 'Merge rows by key' }).click();
	await page.getByLabel('Key field').fill('t');
	await page.getByRole('button', { name: 'Create' }).click();

	// More stored rows than the API ever returned at once: overlapping keys upserted, not duplicated.
	await expect.poll(() => sampleCount(page, 'Series API'), { timeout: 40_000 }).toBeGreaterThan(3);

	// Overlapping keys were upserted, not duplicated.
	const keys = (await sampleRows(page, 'Series API')).map((r) => r.t);
	expect(new Set(keys).size).toBe(keys.length);
});

test('a failed fetch leaves the recorded series intact', async ({ page }) => {
	let fail = false;
	let hits = 0;
	await page.route('https://api.example.test/flaky', async (route) => {
		hits++;
		if (fail) {
			await route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'nope' });
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
			body: JSON.stringify({ cpu: hits })
		});
	});

	await newExternal(page, { name: 'Flaky API', url: 'https://api.example.test/flaky' });
	await page.getByLabel('History').click();
	await page.getByRole('option', { name: 'Record each fetch' }).click();
	await page.getByRole('button', { name: 'Create' }).click();

	await expect.poll(() => sampleCount(page, 'Flaky API'), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
	const before = await sampleCount(page, 'Flaky API');

	fail = true;
	const card = page.locator('[data-datasource-id]', { hasText: 'Flaky API' });
	await card.getByRole('button', { name: 'Fetch now' }).click();
	// The error shows beside the data, not instead of it — the recorded series keeps rendering.
	await expect(card.getByTestId('fetch-error')).toContainText('HTTP 500');
	await expect(card.getByTestId('preview')).toContainText('sampled_at');

	// And no bogus row was written for the failed fetch.
	expect(await sampleCount(page, 'Flaky API')).toBe(before);

	fail = false;
	await card.getByRole('button', { name: 'Fetch now' }).click();
	await expect.poll(() => sampleCount(page, 'Flaky API')).toBe(before + 1);
});
