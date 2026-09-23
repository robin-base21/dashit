import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const relayURL = process.env.E2E_RELAY_URL ?? 'http://localhost:3199';

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.pw.ts',
	timeout: 180_000,
	fullyParallel: false,
	reporter: 'list',
	use: { baseURL },
	webServer: process.env.E2E_BASE_URL
		? undefined
		: [
				{
					command: 'bun run dev -- --port 4173 --strictPort',
					url: baseURL,
					reuseExistingServer: true,
					timeout: 120_000,
					env: {
						VITE_RELAY_URL: relayURL,
						// Stage 2 sends plaintext; the flag is what keeps that out of a production build.
						VITE_DASHIT_PLAINTEXT_SYNC: '1'
					}
				},
				{
					// Playwright runs under Node, so the relay cannot be imported in-process — it
					// needs bun:sqlite. A second web server gives the auth spec a real relay, with
					// an in-memory database and email codes echoed so no mailbox is involved.
					command: 'bun run --filter backend start',
					url: `${relayURL}/api/v1/health`,
					reuseExistingServer: true,
					timeout: 60_000,
					env: {
						PORT: '3199',
						DASHIT_DB: ':memory:',
						DASHIT_DEV_EMAIL_ECHO: '1',
						// The suite shares one IP and the server is reused between runs, so the real
						// limits would make a test's result depend on how many ran before it. The
						// thresholds themselves are asserted in the relay's own tests.
						DASHIT_RELAX_RATE_LIMITS: '1',
						DASHIT_ORIGINS: 'http://localhost:4173,http://localhost:5173'
					}
				}
			],
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	]
});
