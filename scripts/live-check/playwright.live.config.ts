/**
 * Read-only checks against the DEPLOYED app. Run on purpose only:
 *   npx playwright test --config scripts/live-check/playwright.live.config.ts
 * Not under tests/, so `deepspace test run` never picks it up.
 */
import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

export default defineConfig({
  testDir: '.',
  testMatch: '*.live.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'https://halfway-pearl.app.space',
    headless: true,
    launchOptions: chromiumLaunchOptions(),
  },
})
