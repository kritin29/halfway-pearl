/**
 * Phase 5 two-user flow (SPEC §3.5–3.7, §7, §8): Alice starts a fare search
 * on a `__test-` trip; both browsers see progress, then ranked results; the
 * sort tabs reorder; Bob never sees Alice's budget; votes are live; a third
 * full search the same day is refused.
 *
 * No real SerpApi call: `__test-` trips under `deepspace test run` are
 * answered from the saved fixture, varied per route (src/server/flights-source.ts).
 * Travelers fly from ORD (Alice), BOS (Bob) and DEN (a ghost) to AUS, BNA,
 * SAN and MIA, which the fixture prices so all three tabs order differently.
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'
import { act, asClient, captureSocketFrames, createTripApi, testTripName } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)
test.describe.configure({ timeout: 120_000 })

const ALICE_BUDGET = 4321

/**
 * Set my own home airports the way a browser can (RBAC on, writableFields
 * only). The room lets me update only my own row, so try the rows I can see.
 */
async function setOwnAirports(user: MultiplayerUser, baseURL: string, tripId: string, homeAirports: string[]) {
  const rows = await asClient(user, baseURL, 'records_query', { collection: 'travelers', where: { tripId } })
  for (const row of rows.body.result?.data?.records ?? []) {
    const res = await asClient(user, baseURL, 'records_update', {
      collection: 'travelers',
      recordId: row.recordId,
      data: { homeAirports },
    })
    if (res.status === 200 && res.body.ok && res.body.result?.success) return
  }
  throw new Error('could not set my own home airports')
}

/** The card IATAs in on-screen order, with their sort values. */
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

test('Alice finds fares: both see progress then results; tabs reorder; budgets stay private; votes are live; a third search is refused', async ({
  users,
  baseURL,
}) => {
  const [alice, bob] = await users(2)
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('results'))
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode })).toMatchObject({ success: true })

  await setOwnAirports(alice, baseURL!, tripId, ['ORD'])
  await setOwnAirports(bob, baseURL!, tripId, ['BOS'])
  expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName: 'Denver friend', homeAirports: ['DEN'] })).toMatchObject({
    success: true,
  })
  for (const iata of ['AUS', 'BNA', 'SAN', 'MIA']) {
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata }), iata).toMatchObject({ success: true })
  }
  // Alice's private budget, written the way her browser writes it (RBAC on, own row).
  const created = await asClient(alice, baseURL!, 'records_create', { collection: 'budgets', data: { tripId, maxUsd: ALICE_BUDGET } })
  expect(created.body.ok, JSON.stringify(created.body)).toBe(true)

  const bobFrames = captureSocketFrames(bob)
  await Promise.all([alice.page.goto(`/t/${tripId}`), bob.page.goto(`/t/${tripId}`)])
  await bob.page.getByRole('tab', { name: 'Results' }).click()
  await expect(bob.page.getByTestId('results-empty')).toBeVisible({ timeout: 15_000 })
  await alice.page.getByRole('tab', { name: 'Destinations' }).click()

  // Bob can't start it; Alice can.
  await bob.page.getByRole('tab', { name: 'Destinations' }).click()
  await expect(bob.page.getByRole('button', { name: /Find fares/ })).toBeDisabled()
  await bob.page.getByRole('tab', { name: 'Results' }).click()

  await alice.page.getByRole('button', { name: 'Find fares', exact: true }).click()

  // Both see the progress bar (from the trip row), then four ranked cards.
  await expect(bob.page.getByTestId('search-progress')).toBeVisible({ timeout: 15_000 })
  await expect(alice.page.getByTestId('search-progress')).toBeVisible()
  for (const user of [alice, bob]) {
    await expect(user.page.getByTestId('result-card')).toHaveCount(4, { timeout: 60_000 })
    await expect(user.page.getByTestId('search-progress')).toHaveCount(0, { timeout: 30_000 })
    await expect(user.page.locator('[data-testid="result-card"][data-complete="1"]')).toHaveCount(4)
  }

  // Each tab is sorted by its own rule, and the three orders differ.
  const orders: Record<string, string> = {}
  for (const [tab, check] of [
    ['Cheapest', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.total))],
    ['Fairest', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.maxFare))],
    ['Together', (c: Awaited<ReturnType<typeof cards>>) => nondecreasing(c.map((x) => x.spread))],
  ] as const) {
    await bob.page.getByRole('tab', { name: tab }).click()
    await expect(bob.page.getByTestId('result-list')).toHaveAttribute('data-mode', tab.toLowerCase())
    const list = await cards(bob)
    expect(check(list), `${tab}: ${JSON.stringify(list)}`).toBe(true)
    orders[tab] = list.map((c) => c.iata).join('>')
  }
  expect(new Set(Object.values(orders)).size, JSON.stringify(orders)).toBe(3)

  // Each card shows every traveler's fare with origin, stops and times, and a booking link.
  const firstCard = bob.page.getByTestId('result-card').first()
  await expect(firstCard.getByTestId('result-person')).toHaveCount(3)
  await expect(firstCard.getByTestId('result-person').filter({ hasText: 'Denver friend' })).toContainText('From DEN')
  await expect(firstCard.getByRole('link', { name: /Book .* flight on Google Flights/ }).first()).toHaveAttribute(
    'href',
    /^https:\/\/www\.google\.com\/travel\/flights/,
  )

  // Alice sees her own fare vs her budget; Bob sees no budget anywhere.
  await expect(alice.page.getByTestId('own-fit').first()).toContainText(`$${ALICE_BUDGET.toLocaleString('en-US')} budget`)
  await expect(alice.page.getByTestId('own-fit')).toHaveCount(4)
  await expect(bob.page.getByTestId('own-fit')).toHaveCount(0)
  // Only one budget on the trip: the fits-everyone badge stays hidden (privacy guard).
  await expect(bob.page.getByTestId('fits-all-badge')).toHaveCount(0)
  const bobText = await bob.page.locator('body').innerText()
  expect(bobText).not.toContain('4,321')
  expect(bobText).not.toContain('4321')
  expect(bobFrames.some((f) => f.includes(String(ALICE_BUDGET)))).toBe(false)
  const bobBudgets = await asClient(bob, baseURL!, 'records_query', { collection: 'budgets', where: { tripId } })
  expect(bobBudgets.body.result?.data?.records ?? []).toHaveLength(0)

  // Votes are live both ways.
  const voteCount = (user: MultiplayerUser) =>
    user.page.locator('[data-testid="result-card"][data-iata="BNA"]').getByTestId('vote-count')
  await bob.page.getByRole('button', { name: 'Vote for Nashville' }).click()
  await expect(voteCount(alice)).toHaveAttribute('data-count', '1')
  await expect(voteCount(alice)).toContainText('Bob')
  await alice.page.getByRole('button', { name: 'Vote for Nashville' }).click()
  await expect(voteCount(bob)).toHaveAttribute('data-count', '2')
  await expect(voteCount(bob)).toContainText('You')
  await bob.page.getByRole('button', { name: 'Remove your vote for Nashville' }).click()
  await expect(voteCount(alice)).toHaveAttribute('data-count', '1')

  // A second full search today is allowed (and served from the 6h cache)…
  const second = await act<{ jobId: string }>(alice, baseURL!, 'startSearch', { tripId })
  expect(second).toMatchObject({ success: true })
  // Wait until THAT job has finished (the trip row says so), not just until the bar is gone.
  await expect
    .poll(
      async () => {
        const res = await asClient(bob, baseURL!, 'records_query', { collection: 'trips', where: { recordId: tripId } })
        const trip = res.body.result?.data?.records?.[0]?.data
        return trip ? `${trip.status}|${trip.searchJobId === second.data!.jobId}` : 'missing'
      },
      { timeout: 60_000 },
    )
    .toBe('results|true')
  await expect(bob.page.locator('[data-testid="result-card"][data-complete="1"]')).toHaveCount(4)
  // …the third is refused, and the button explains why.
  expect(await act(alice, baseURL!, 'startSearch', { tripId })).toMatchObject({ success: false, code: 'cap_reached' })
  await alice.page.getByRole('tab', { name: 'Destinations' }).click()
  await alice.page.getByRole('button', { name: 'Find fares again' }).click()
  await expect(alice.page.getByTestId('search-start-error')).toContainText('already ran 2 fare searches today')
})
