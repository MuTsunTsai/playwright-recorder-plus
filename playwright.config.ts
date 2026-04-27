import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./test",
	timeout: 60_000,
	// Workers default to half-CPU; a single recorder per worker is enough for
	// smoke tests and keeps ffmpeg processes from contending.
	workers: 1,
	use: {
		viewport: { width: 1280, height: 720 },
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
});
