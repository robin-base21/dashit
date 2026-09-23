import { expect, test, type Page } from '@playwright/test';

/**
 * The passkey ceremonies, driven by a CDP virtual authenticator. That API is Chromium-only, so
 * these skip elsewhere rather than failing — the rest of the suite covers the other engines.
 *
 * The relay is a second web server started by playwright.config.ts, with an in-memory database and
 * `DASHIT_DEV_EMAIL_ECHO=1` so the code comes back in the response and no mailbox is involved.
 */

/** Unique per run: the relay may be reused between runs, and an address can register only once. */
const freshEmail = (tag: string) => `${tag}-${Date.now().toString(36)}@example.test`;

test.describe('passkey accounts', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CDP virtual authenticator is Chromium-only');

	/** Watches for the dev-echoed registration code, which stands in for a mailbox. */
	function watchForCode(page: Page): () => string {
		let code = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/register')) return;
			code = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? code;
		});
		return () => code;
	}

	const AUTHENTICATOR = {
		protocol: 'ctap2',
		transport: 'internal',
		hasResidentKey: true,
		hasUserVerification: true,
		isUserVerified: true,
		automaticPresenceSimulation: true
	} as const;

	async function virtualAuthenticator(page: Page) {
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('WebAuthn.enable');
		const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: { ...AUTHENTICATOR }
		});
		/**
		 * A second authenticator for a second passkey. Chrome allows only one *internal* one per
		 * environment, so this is a USB security key — which is a realistic second passkey anyway.
		 */
		const addAnotherDevice = async () => {
			const res = await cdp.send('WebAuthn.addVirtualAuthenticator', {
				options: { ...AUTHENTICATOR, transport: 'usb' }
			});
			return res.authenticatorId;
		};
		return { cdp, authenticatorId, addAnotherDevice };
	}

	test('register with an emailed code, then sign in with the passkey alone', async ({ page }) => {
		await virtualAuthenticator(page);

		// The code is echoed by the dev sender; read it from the network rather than a mailbox.
		let devCode = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/register')) return;
			devCode = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? '';
		});

		const email = freshEmail('sam');
		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		await page.getByTestId('send-code').click();

		await expect.poll(() => devCode).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(devCode);
		await page.getByTestId('check-code').click();

		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });

		// Signed in, with the passkey listed.
		const account = page.getByTestId('account-card');
		await expect(account).toContainText(email);
		await expect(account.getByTestId('credential-list').locator('[data-credential-id]')).toHaveCount(1);

		// Sign out, then back in with no email typed — the credential is discoverable.
		await account.getByRole('button', { name: 'Sign out' }).click();
		await expect(account).toContainText('Anonymous mode');

		await page.goto('/login');
		await page.getByTestId('signin').click();
		await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
		await page.goto('/settings');
		await expect(page.getByTestId('account-card')).toContainText(email);
	});

	test('signing up with an address that already has an account offers sign-in', async ({ page }) => {
		await virtualAuthenticator(page);
		const code = watchForCode(page);
		const email = freshEmail('again');

		// Register once.
		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		await page.getByTestId('send-code').click();
		await expect.poll(code).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(code());
		await page.getByTestId('check-code').click();
		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
		await page.getByTestId('account-card').getByRole('button', { name: 'Sign out' }).click();

		// Try again with the same address: no code is sent, and the response cannot say so.
		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		const before = code();
		await page.getByTestId('send-code').click();
		await expect(page.getByLabel('Six-digit code')).toBeVisible();
		// Still on the code step, and genuinely no new code — this is the dead end being fixed.
		expect(code()).toBe(before);

		// The way out is offered right there, and it works.
		await page.getByTestId('pivot-signin').click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByTestId('signin').click();
		await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
		await page.goto('/settings');
		await expect(page.getByTestId('account-card')).toContainText(email);
	});

	test('a failed ceremony always says something, naming the cross-device route', async ({ page }) => {
		// An authenticator with no credential: WebAuthn reports the same NotAllowedError it uses for
		// a cancelled prompt, so the symptom of the old bug was *no output at all*.
		await virtualAuthenticator(page);
		await page.goto('/login');
		await page.getByTestId('signin').click();

		const error = page.getByTestId('login-error');
		await expect(error).toBeVisible({ timeout: 30_000 });
		await expect(error).toContainText('another device');
	});

	test('a second passkey can be added, and then the first can be removed', async ({ page }) => {
		const { addAnotherDevice } = await virtualAuthenticator(page);
		const code = watchForCode(page);
		const email = freshEmail('two');

		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		await page.getByTestId('send-code').click();
		await expect.poll(code).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(code());
		await page.getByTestId('check-code').click();
		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });

		// Enrolment is confirmed by its own emailed code.
		let enrolCode = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/enroll/start')) return;
			enrolCode = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? enrolCode;
		});
		// `excludeCredentials` stops a second passkey landing on the authenticator that already holds
		// one, which is correct — so stand up another, as a real second device would be.
		await addAnotherDevice();
		await page.getByTestId('add-passkey').click();
		await expect.poll(() => enrolCode).toMatch(/^\d{6}$/);
		await page.getByLabel('Enter the code we emailed you').fill(enrolCode);
		await page.getByTestId('confirm-passkey').click();
		await expect(page.locator('[data-credential-id]')).toHaveCount(2, { timeout: 30_000 });

		// With two, the last-passkey guard stops refusing — the other half of that rule. Removing the
		// *first* also removes the credential signing this device in, which ends the session (§4.5),
		// so the app must say so instead of leaving a stale list above a dead session.
		await page.locator('[data-credential-id]').first().getByRole('button', { name: 'Remove passkey' }).click();
		await expect(page.getByText('you were signed out')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('account-card')).toContainText('Anonymous mode');
	});

	test('adding a passkey to the device that already has one explains itself', async ({ page }) => {
		// `excludeCredentials` correctly refuses a second passkey on the same authenticator. The
		// browser's own words for that are unreadable, so the app must translate them.
		await virtualAuthenticator(page);
		const code = watchForCode(page);
		const email = freshEmail('same');

		await page.goto('/register');
		await page.getByLabel('Email').fill(email);
		await page.getByTestId('send-code').click();
		await expect.poll(code).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(code());
		await page.getByTestId('check-code').click();
		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });

		let enrolCode = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/enroll/start')) return;
			enrolCode = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? enrolCode;
		});
		await page.getByTestId('add-passkey').click();
		await expect.poll(() => enrolCode).toMatch(/^\d{6}$/);
		await page.getByLabel('Enter the code we emailed you').fill(enrolCode);
		await page.getByTestId('confirm-passkey').click();

		// Scoped to the error toast: the success one from registration is still on screen.
		const toast = page.locator('[data-sonner-toast][data-type="error"]');
		await expect(toast).toContainText('already has a passkey', { timeout: 15_000 });
		// And no raw WebAuthn wording reaches the user.
		await expect(toast).not.toContainText('relying party');
	});

	test('the only passkey cannot be removed', async ({ page }) => {
		await virtualAuthenticator(page);

		let devCode = '';
		page.on('response', async (res) => {
			if (!res.url().endsWith('/auth/register')) return;
			devCode = ((await res.json().catch(() => ({}))) as { dev_code?: string }).dev_code ?? '';
		});

		await page.goto('/register');
		await page.getByLabel('Email').fill(freshEmail('only'));
		await page.getByTestId('send-code').click();
		await expect.poll(() => devCode).toMatch(/^\d{6}$/);
		await page.getByLabel('Six-digit code').fill(devCode);
		await page.getByTestId('check-code').click();
		await page.getByTestId('make-passkey').click();
		await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });

		const row = page.locator('[data-credential-id]').first();
		await row.getByRole('button', { name: 'Remove passkey' }).click();
		// Refused, and the passkey is still there.
		await expect(page.getByText('That is your only passkey')).toBeVisible();
		await expect(page.locator('[data-credential-id]')).toHaveCount(1);
	});
});

test('the dashboard works with no account and no relay', async ({ page }) => {
	// Anonymous mode is permanent (§4.9): nothing may gate the app behind signing in.
	await page.goto('/dashboard');
	await expect(page.getByTestId('dashboard-grid')).toBeVisible({ timeout: 60_000 });
	await page.goto('/settings');
	await expect(page.getByTestId('account-card')).toContainText('Anonymous mode');
});
