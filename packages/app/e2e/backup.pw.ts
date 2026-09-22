import { expect, test } from '@playwright/test';

test('export downloads JSON and import restores it into a fresh database', async ({ page, context }) => {
	await page.goto('/dashboard');
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 60_000 });

	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: /Table/ }).click();
	await page.getByLabel('Title').fill('Backed up');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('aside [data-element-id]', { hasText: 'Backed up' })).toBeVisible();

	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await expect(page.getByTestId('eviction-banner')).toBeVisible();

	const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
	const path = await download.path();
	expect(download.suggestedFilename()).toMatch(/^dashit-.*\.json$/);
	const file = JSON.parse(await (await import('node:fs/promises')).readFile(path!, 'utf8'));
	expect(file.format).toBe('dashit-export');
	expect(file.tables.elements.some((e: { title: string }) => e.title === 'Backed up')).toBe(true);

	// A fresh context has empty storage; importing brings the element back.
	const fresh = await context.browser()!.newContext();
	const p2 = await fresh.newPage();
	await p2.goto('/settings');
	await expect(p2.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
	await expect(p2.getByTestId('eviction-banner')).toHaveCount(0);
	await p2.getByTestId('import-input').setInputFiles(path!);
	await expect(p2.getByText(/Imported \d+ rows/)).toBeVisible();
	await p2.getByRole('link', { name: 'Dashboard' }).click();
	await p2.getByRole('button', { name: 'Elements', exact: true }).click();
	await expect(p2.locator('aside [data-element-id]', { hasText: 'Backed up' })).toBeVisible();
	await fresh.close();
});
