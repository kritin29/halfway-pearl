import { test, expect } from '@playwright/test'
import { captureConsoleErrors } from './helpers/errors'

/**
 * Smoke tests covering both page kinds:
 *   - '/'       → the static landing (top level of src/pages/): no providers,
 *                 so no auth fetch and no records WebSocket on load.
 *   - '/trips'  → a dynamic page (under src/pages/(app)/): the providers mount,
 *                 the nav shell renders, and the records WebSocket connects.
 *
 * The "static contract" test is the guardrail for the per-page opt-out: if
 * someone moves the providers back up into _app.tsx, it fails.
 */

/** Wait for the React app shell (present on every page). */
async function waitForApp(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 15000 })
}

test.describe('Smoke tests', () => {
  test('static landing loads without JS errors', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.goto('/')
    await waitForApp(page)
    await expect(page.getByTestId('static-landing')).toBeVisible({ timeout: 15000 })
    expect(errors).toEqual([])
  })

  test('landing is Halfway’s own page: pitch, how it works, differentiators, Start a trip', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meet in the middle, fairly.', { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'Three stops to a plan' })).toBeVisible()
    for (const label of ['Private budgets', 'Daily fare watch', 'Arrival alignment']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible()
    }
    // No scaffold copy left behind.
    await expect(page.getByText(/static front door|placeholder page|Enter the app/i)).toHaveCount(0)
    const start = page.getByTestId('landing-start')
    await expect(start).toHaveText(/Start a trip/)
    await start.click()
    await expect(page).toHaveURL(/\/trips$/)
  })

  test('landing carries one title, one description, one canonical', async ({ page }) => {
    // <Seo> (src/pages/index.tsx, values from src/seo.ts) hoists these into
    // <head>. Exactly one of each: index.html ships no static description or
    // canonical, because React 19 would not dedupe against them on mount.
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible({ timeout: 15000 })
    await expect(page).toHaveTitle(/^Halfway \| /)
    expect(await page.locator('head meta[name="description"]').count()).toBe(1)
    expect(await page.locator('head link[rel="canonical"]').count()).toBe(1)
  })

  test('static contract: landing fires no auth request, opens no websocket', async ({ page }) => {
    const offenders: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/')) offenders.push(req.url())
    })
    // Only the DO room route counts — vite's own HMR socket is a dev artifact.
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname.startsWith('/ws/')) offenders.push(`ws: ${ws.url()}`)
    })
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(1500)
    expect(offenders).toEqual([])
  })

  test('dynamic app boundary mounts on /trips', async ({ page }) => {
    await page.goto('/trips')
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 15000 })
  })

  test('the nav has Trips and sign-in only; the scaffold pages are gone', async ({ page }) => {
    await page.goto('/trips')
    const nav = page.getByTestId('app-navigation')
    await expect(nav).toBeVisible({ timeout: 15000 })
    await expect(nav.getByRole('link', { name: 'Trips', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: /^(Home|Settings|API Status)$/ })).toHaveCount(0)
    for (const path of ['/settings', '/api-status']) {
      await page.goto(path)
      await expect(page.getByText('Error 404')).toBeVisible()
    }
  })

  test('/home forwards to /trips', async ({ page }) => {
    await page.goto('/home')
    await expect(page).toHaveURL(/\/trips$/, { timeout: 15000 })
  })

  test('signed out: /trips offers sign-in, with a page title', async ({ page }) => {
    await page.goto('/trips')
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('nav-user-name')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Sign in to plan together' })).toBeVisible()
    await expect(page).toHaveTitle('Sign in · Halfway')
  })

  test('unknown route shows a friendly 404 with a way back', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz')
    await waitForApp(page)
    await expect(page.getByText('Error 404')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/doesn’t land anywhere/)
    await expect(page).toHaveTitle('Page not found · Halfway')
    await expect(page.getByRole('link', { name: /Go to your trips/ })).toHaveAttribute('href', '/trips')
  })

  test('favicon is Halfway’s, not the scaffold default', async ({ page, request }) => {
    await page.goto('/')
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/favicon.svg')
    const svg = await request.get('/favicon.svg')
    expect(svg.ok()).toBe(true)
    expect(await svg.text()).toContain('<svg')
  })
})
