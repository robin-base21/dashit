import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Two browser contexts are two devices on one account.
 *
 * The second gets in by injecting the first's credential through CDP — which is precisely what a
 * synced passkey is in real life, and the only way to have one account on two profiles. This is
 * Chromium-only, and it is also the *only* place CRDT convergence can be proven: the bun:sqlite
 * test double has no cr-sqlite, so `changesSince`/`applyChanges` throw outside a browser.
 */
const AUTHENTICATOR = {
	protocol: 'ctap2',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true
} as const;

test.describe('sync', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CDP virtual authenticator is Chromium-only');
	test.describe.configure({ mode: 'serial' });

	async function authenticator(context: BrowserContext, page: Page) {
		const cdp = await context.newCDPSession(page);
		await cdp.send('WebAuthn.enable');
		const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { ...AUTHENTICATOR } });
		return { cdp, authenticatorId };
	}

	async function register(page: Page, email: string) {
		let code = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/register')) return;
			code = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? code;
		});
		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		await page.getByTestId('send-code').click();
		await expect.poll(() => code).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(code);
		await page.getByTestId('check-code').click();
		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
	}

	async function signIn(page: Page) {
		await page.goto('/login');
		await page.getByTestId('signin').click();
		await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
	}

	/** Places a task list and returns its card. */
	async function addTaskList(page: Page, title: string) {
		await page.goto('/dashboard');
		const grid = page.getByTestId('dashboard-grid');
		await expect(grid).toBeVisible({ timeout: 60_000 });
		const gb = (await grid.boundingBox())!;
		if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
			await page.getByRole('button', { name: 'Elements', exact: true }).click();
		}
		await page.getByRole('button', { name: 'New' }).click();
		await page.getByRole('radio', { name: /Task list/ }).click();
		await page.getByLabel('Title').fill(title);
		await page.getByRole('button', { name: 'Create' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const handle = page
			.locator('aside [data-element-id]', { hasText: title })
			.getByRole('button', { name: 'Drag onto the dashboard' });
		const box = (await handle.boundingBox())!;
		await page.mouse.move(box.x + 8, box.y + 8);
		await page.mouse.down();
		await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
		await page.mouse.move(gb.x + 60, gb.y + 40, { steps: 10 });
		await page.mouse.up();
		const card = grid.locator('article[data-element-id]', { hasText: title });
		await expect(card).toBeVisible();
		return card;
	}

	/** Creates an element without placing it, so it is not tied to this device's dashboard row. */
	async function createUnplaced(page: Page, kind: string, title: string) {
		await page.goto('/dashboard');
		await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 60_000 });
		if (!(await page.locator('aside[aria-label="Elements"]').isVisible())) {
			await page.getByRole('button', { name: 'Elements', exact: true }).click();
		}
		await page.getByRole('button', { name: 'New' }).click();
		await page.getByRole('radio', { name: new RegExp(kind) }).click();
		await page.getByLabel('Title').fill(title);
		await page.getByRole('button', { name: 'Create' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}

	async function addItem(card: ReturnType<Page['locator']>, text: string) {
		const input = card.getByRole('textbox', { name: 'New item' });
		await input.fill(text);
		await input.press('Enter');
		await expect(card.getByText(text)).toBeVisible();
	}

	test('two devices converge after concurrent offline edits', async ({ browser }) => {
		test.setTimeout(180_000);
		const email = `sync-${Date.now().toString(36)}@example.test`;

		const ctxA = await browser.newContext();
		const pageA = await ctxA.newPage();
		const authA = await authenticator(ctxA, pageA);
		await register(pageA, email);

		// Device B gets device A's credential, exactly as a synced passkey would arrive.
		const { credentials } = await authA.cdp.send('WebAuthn.getCredentials', {
			authenticatorId: authA.authenticatorId
		});
		expect(credentials.length).toBeGreaterThan(0);

		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		const authB = await authenticator(ctxB, pageB);
		await authB.cdp.send('WebAuthn.addCredential', {
			authenticatorId: authB.authenticatorId,
			credential: credentials[0]!
		});
		await signIn(pageB);

		// A creates a list and it reaches B without waiting for the poll — that is the nudge.
		const listA = await addTaskList(pageA, 'Chores');
		await addItem(listA, 'Buy milk');
		await pageB.goto('/dashboard');
		const listB = pageB.getByTestId('dashboard-grid').locator('article[data-element-id]', { hasText: 'Chores' });
		await expect(listB).toBeVisible({ timeout: 45_000 });
		await expect(listB.getByText('Buy milk')).toBeVisible({ timeout: 45_000 });

		// Both go offline and edit the same list with different items.
		await ctxA.setOffline(true);
		await ctxB.setOffline(true);
		await addItem(listA, 'From A');
		await addItem(listB, 'From B');

		// Back online, each other's edits arrive and neither is lost.
		await ctxA.setOffline(false);
		await ctxB.setOffline(false);
		await expect(listA.getByText('From B')).toBeVisible({ timeout: 60_000 });
		await expect(listB.getByText('From A')).toBeVisible({ timeout: 60_000 });
		await expect(listA.getByText('From A')).toBeVisible();
		await expect(listB.getByText('Buy milk')).toBeVisible();

		await ctxA.close();
		await ctxB.close();
	});

	test('anonymous data is offered for merge when signing in', async ({ browser }) => {
		test.setTimeout(120_000);
		const email = `merge-${Date.now().toString(36)}@example.test`;

		// Register on one device so an account exists.
		const ctxA = await browser.newContext();
		const pageA = await ctxA.newPage();
		const authA = await authenticator(ctxA, pageA);
		await register(pageA, email);
		const { credentials } = await authA.cdp.send('WebAuthn.getCredentials', {
			authenticatorId: authA.authenticatorId
		});

		// A second device that already has local work, created before signing in.
		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		const authB = await authenticator(ctxB, pageB);
		await authB.cdp.send('WebAuthn.addCredential', {
			authenticatorId: authB.authenticatorId,
			credential: credentials[0]!
		});
		// Unplaced on purpose: merging two devices' anonymous data yields two `dashboards` rows
		// (§4.8), so a *placed* element would sync but sit on B's dashboard, which A never shows.
		// The reconciliation of those two dashboards is its own feature.
		await createUnplaced(pageB, 'Task list', 'Local work');
		await signIn(pageB);

		// The choice is offered rather than the work being silently dropped or merged.
		const merge = pageB.getByTestId('merge-local');
		await expect(merge).toBeVisible({ timeout: 30_000 });
		await merge.click();
		await expect(pageB.getByRole('dialog')).toHaveCount(0);

		// And it reaches the other device, where it is waiting to be placed.
		await pageA.goto('/dashboard');
		if (!(await pageA.locator('aside[aria-label="Elements"]').isVisible())) {
			await pageA.getByRole('button', { name: 'Elements', exact: true }).click();
		}
		await expect(pageA.locator('aside [data-element-id]', { hasText: 'Local work' })).toBeVisible({
			timeout: 60_000
		});

		await ctxA.close();
		await ctxB.close();
	});
});
