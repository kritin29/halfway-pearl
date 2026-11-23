/**
 * Demo trips (SPEC §14), solo: a user presses "Try a demo trip" on /trips and
 * gets a working trip with sample fares: results arrive, the tabs sort, they
 * vote, lock (no emails), check fares again, and the demo label is on every
 * screen and card. Clients can't write the demo flag.
 *
 * No paid calls: demo trips are answered from the fixture in every env, and
 * send no email. The request from the real button is rewritten at the network
 * layer to add a `__test-` name, which the server honours only under
 * `deepspace test run` (ALLOW_DEBUG_ROUTES), so repeated runs don't hit the
 * 3-per-day demo cap on the pool account. The cap itself is unit-tested.
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'
import { asClient, testTripName, waitForTrip } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 1, `Needs 1 usable test account, found ${usable}.`)
test.describe.configure({ timeout: 150_000 })

const LABEL = 'Demo trip: sample prices, not live fares.'
const EMAILS_OFF = 'Emails are off in demo trips.'

async function cards(user: MultiplayerUser) {
  return user.page.getByTestId('result-card').evaluateAll((els) =>
    els.map((el) => ({
      iata: el.getAttribute('data-iata') ?? '',
      total: Number(el.getAttribute('data-total')),
      maxFare: Number(el.getAttribute('data-maxfare')),
      spread: Number(el.getAttribute('data-spread')),
    })),
  )
}
const nondecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x)

test('solo: Try a demo trip → results, sort, vote, lock without emails, check fares; the label is everywhere', async ({
  users,
  baseURL,
}) => {
  const [alice] = await users(1)
  const page = alice.page
  const name = testTripName('demo')
  await page.route('**/api/actions/createDemoTrip', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    await route.continue({ postData: JSON.stringify({ ...body, testName: name }) })
  })

  // 1. The button on /trips opens the new demo trip.
  await page.goto('/trips')
  await expect(page.getByTestId('demo-offer')).toContainText(EMAILS_OFF)
  await page.getByRole('button', { name: 'Try a demo trip' }).click({ timeout: 15_000 })
  await page.waitForURL(/\/t\/[^/]+$/, { timeout: 30_000 })
  const tripId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByTestId('trip-name')).toHaveText(name)
  await expect(page.getByTestId('demo-banner')).toContainText(LABEL)
  await expect(page.getByTestId('demo-banner')).toContainText(EMAILS_OFF)

  // 2. The normal search runs by itself; 4 ranked cards, each labelled, each with 3 travelers' sample fares.
  await expect(page.locator('[data-testid="result-card"][data-complete="1"]')).toHaveCount(4, { timeout: 60_000 })
  await expect(page.getByTestId('search-progress')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('result-card').getByTestId('demo-label')).toHaveCount(4)
  for (const label of await page.getByTestId('result-card').getByTestId('demo-label').allInnerTexts()) {
    expect(label.trim()).toBe(LABEL)
  }
  const first = page.getByTestId('result-card').first()
  await expect(first.getByTestId('result-person')).toHaveCount(3)
  await expect(first.getByTestId('result-person').filter({ hasText: 'Priya' })).toContainText('From DEN')
  await expect(first.getByTestId('result-person').filter({ hasText: 'Sam' })).toContainText('From BOS')

  // 3. Each sort tab orders by its own rule, and the three orders differ.
  const orders: Record<string, string> = {}
  for (const [tab, check] of [
    ['Cheapest', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.total))],
    ['Fairest', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.maxFare))],
    ['Together', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.spread))],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click()
    await expect(page.getByTestId('result-list')).toHaveAttribute('data-mode', tab.toLowerCase())
    const list = await cards(alice)
    expect(check(list), `${tab}: ${JSON.stringify(list)}`).toBe(true)
    orders[tab] = list.map((c) => c.iata).join('>')
  }
  expect(new Set(Object.values(orders)).size, JSON.stringify(orders)).toBe(3)

  // 4. Vote.
  const nashville = page.locator('[data-testid="result-card"][data-iata="BNA"]')
  await page.getByRole('button', { name: 'Vote for Nashville' }).click()
  await expect(nashville.getByTestId('vote-count')).toHaveAttribute('data-count', '1')

  // 5. Lock: the dialog and the result say no emails go out; the page moves to Book.
  await nashville.getByTestId('lock-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(EMAILS_OFF)
  await dialog.getByRole('button', { name: 'Lock destination' }).click()
  await expect(page.getByText(`${EMAILS_OFF} Everyone’s booking link is on the Book tab.`)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: 'Book' })).toHaveAttribute('aria-selected', 'true')
  await waitForTrip(alice, baseURL!, tripId, (t) => t.status === 'locked' && t.lockedIata === 'BNA')

  // 6. Book: every card labelled; no resend button, the emails-off note instead; no daily switch.
  await expect(page.getByTestId('demo-banner')).toBeVisible()
  await expect(page.getByTestId('locked-destination').getByTestId('demo-label')).toHaveText(LABEL)
  await expect(page.getByTestId('your-flight').getByTestId('demo-label')).toHaveText(LABEL)
  await expect(page.getByTestId('your-fare')).toContainText('$')
  await expect(page.getByTestId('fare-watch').getByTestId('demo-label')).toHaveText(LABEL)
  await expect(page.getByTestId('demo-emails-off')).toContainText(EMAILS_OFF)
  await expect(page.getByRole('button', { name: 'Email booking links again' })).toHaveCount(0)
  await expect(page.getByTestId('watch-toggle')).toHaveCount(0)
  await expect(page.getByTestId('fare-watch').getByTestId('watch-status')).toContainText(EMAILS_OFF)

  // 7. "Check fares now" works with sample data: a new snapshot, no error.
  await expect(page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '1', { timeout: 15_000 })
  await page.getByTestId('check-fares-now').click()
  await expect(page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '2', { timeout: 30_000 })
  await waitForTrip(alice, baseURL!, tripId, (t) => !t.watchQueuedAt && !t.watchError)
  await expect(page.getByTestId('watch-error')).toHaveCount(0)

  // 8. The trips list labels it too.
  await page.goto('/trips')
  await expect(page.locator(`a[href="/t/${tripId}"]`).getByTestId('demo-label')).toHaveText(LABEL, { timeout: 15_000 })

  // 9. The client can't write the flag: not on this trip, and not by creating a trip.
  const flip = await asClient(alice, baseURL!, 'records_update', { collection: 'trips', recordId: tripId, data: { isDemo: 0 } })
  expect(flip.status === 200 && flip.body.ok && flip.body.result?.success, JSON.stringify(flip.body)).toBeFalsy()
  const forged = await asClient(alice, baseURL!, 'records_create', {
    collection: 'trips',
    data: { name: '__test-forged', inviteCode: `forged${Date.now()}`, outboundDate: '2027-01-08', returnDate: '2027-01-10', isDemo: 1 },
  })
  expect(forged.status === 200 && forged.body.ok && forged.body.result?.success, JSON.stringify(forged.body)).toBeFalsy()
  await waitForTrip(alice, baseURL!, tripId, (t) => t.isDemo === 1)
})
