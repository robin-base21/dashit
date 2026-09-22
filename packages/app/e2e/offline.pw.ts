import { expect, test } from '@playwright/test';

// The service worker only precaches in production builds; run with
//   bun run build && bun run preview -- --port 4174 && E2E_BASE_URL=http://localhost:4174 bunx playwright test offline
test.skip(!process.env.E2E_BASE_URL, 'requires a production build (E2E_BASE_URL)');

test('app shell and data load with the network disabled', async ({ page, context }) => {
	await page.goto('/dashboard');
	const grid = page.getByTestId('dashboard-grid');
	await expect(grid).toBeVisible({ timeout: 60_000 });

	// Create something so there is data to come back to.
	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await page.getByRole('button', { name: 'New' }).click();
	await page.getByRole('radio', { name: /Task/ }).click();
	await page.getByLabel('Title').fill('Offline task');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('aside [data-element-id]', { hasText: 'Offline task' })).toBeVisible();

	// Wait for the service worker to control the page.
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((res) => navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true }));
		}
		return reg.active?.state;
	});

	await context.setOffline(true);
	await page.reload();
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Elements', exact: true }).click();
	await expect(page.locator('aside [data-element-id]', { hasText: 'Offline task' })).toBeVisible();

	// Client-side navigation to another route also works offline.
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(page.getByTestId('eviction-banner')).toBeVisible();
	await context.setOffline(false);
});
