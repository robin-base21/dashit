import { expect, test } from '@playwright/test';

test('theme toggle applies immediately and persists across reload', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
	const html = page.locator('html');
	await expect(html).not.toHaveClass(/dark/);

	await page.getByRole('radio', { name: 'Dark' }).click();
	await expect(html).toHaveClass(/dark/);
	await expect(page.getByText('Currently showing the dark theme.')).toBeVisible();

	await page.reload();
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
	await expect(html).toHaveClass(/dark/);
	await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
	await page.screenshot({ path: 'test-results/settings-dark.png' });

	// System follows the OS preference.
	await page.getByRole('radio', { name: 'System' }).click();
	await expect(html).not.toHaveClass(/dark/);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(html).toHaveClass(/dark/);

	await page.getByRole('radio', { name: 'Light' }).click();
	await expect(html).not.toHaveClass(/dark/);
});
