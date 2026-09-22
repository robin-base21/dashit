import { expect, test } from '@playwright/test';

test('static datasources can be imported from CSV and JSON files', async ({ page }) => {
	await page.goto('/datasources');
	await expect(page.getByRole('button', { name: 'New datasource' })).toBeVisible({ timeout: 60_000 });

	// CSV with a semicolon delimiter, a quoted comma, a blank cell.
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByRole('button', { name: 'Import file' }).click({ trial: true }); // button exists
	await page.getByTestId('static-import').setInputFiles({
		name: 'inventory.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('name;qty;instock\n"Smith, J";3;true\nDoe;;false\n')
	});
	await expect(page.getByTestId('import-summary')).toContainText('2 records from inventory.csv');
	await expect(page.getByLabel('Name')).toHaveValue('inventory');
	const json = page.getByLabel('JSON value');
	await expect(json).toHaveValue(/"name": "Smith, J"/);
	await expect(json).toHaveValue(/"qty": 3/);
	await expect(json).toHaveValue(/"qty": null/);
	await expect(json).toHaveValue(/"instock": false/);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('[data-datasource-id]', { hasText: 'inventory' }).getByText('2 records')).toBeVisible();

	// JSON file, name kept when already set.
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByLabel('Name').fill('Cities');
	await page.getByTestId('static-import').setInputFiles({
		name: 'cities.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify([{ city: 'Oslo' }, { city: 'Rome' }, { city: 'Lima' }]))
	});
	await expect(page.getByTestId('import-summary')).toContainText('3 records from cities.json');
	await expect(page.getByLabel('Name')).toHaveValue('Cities');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('[data-datasource-id]', { hasText: 'Cities' }).getByText('3 records')).toBeVisible();

	// Invalid JSON keeps the dialog open with the parser message.
	await page.getByRole('button', { name: 'New datasource' }).click();
	await page.getByTestId('static-import').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ nope') });
	await expect(page.getByText(/Could not import broken.json/)).toBeVisible();
	await expect(page.getByRole('dialog')).toBeVisible();
});
