import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './demo/e2e',
  outputDir: './artifacts/playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/script-vm-next/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Local cloud environments can reuse a system browser. CI uses the
          // Chromium version installed by `playwright install chromium`.
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm demo:build && pnpm demo:preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/script-vm-next/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
