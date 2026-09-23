import { expect, type Page } from '@playwright/test';

/**
 * Picks one option from a shadcn/bits-ui Select.
 *
 * bits-ui keeps a closing listbox mounted through its exit animation, so opening the next select
 * while the last is still detaching leaves two on screen: an option name can match in both, and a
 * stale overlay can swallow the click that follows. Waiting for the close makes chained selects
 * deterministic instead of load-dependent — which is what made several specs flaky under a full
 * parallel run while passing in isolation.
 */
export async function pickOption(page: Page, trigger: string | RegExp, option: string | RegExp): Promise<void> {
	// Exact for a string: trigger labels overlap heavily ("Field" is a prefix of "X field",
	// "Value field" and "Metric field"), so a loose match picks the wrong select.
	await page.getByRole('button', { name: trigger, exact: typeof trigger === 'string' }).click();
	const listbox = page.getByRole('listbox');
	await expect(listbox).toHaveCount(1);
	await listbox.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
	await expect(page.getByRole('listbox')).toHaveCount(0);
}
