import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.pw.ts',
	timeout: 180_000,
	fullyParallel: false,
	reporter: 'list',
	use: { baseURL },
	webServer: process.env.E2E_BASE_URL
		? undefined
		: {
				command: 'bun run dev -- --port 4173 --strictPort',
				url: baseURL,
				reuseExistingServer: true,
				timeout: 120_000
			},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	]
});
