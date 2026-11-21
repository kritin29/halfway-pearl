/**
 * Phase 3b two-user flows (SPEC §3, §12): create → invite → join, live crew
 * updates, budget privacy, non-member not-found, invite refusals, and the
 * usage ledger staying invisible to clients.
 *
 * Trips are named `__test-…` so repeated local runs don't hit the per-user
 * trip-creation cap (exempt only when ALLOW_DEBUG_ROUTES === 'true').
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'
import {
  act,
  asClient,
  captureSocketFrames,
  createTripApi,
  futureDate,
  openApp,
  testTripName,
} from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)
test.describe.configure({ timeout: 90_000 })

const BUDGET = 437

/** Alice sets her private budget on the trip page she has open. */
async function setBudget(alice: MultiplayerUser, amount: number) {
  await alice.page.locator('#budget-input').fill(String(amount))
  await alice.page.getByRole('button', { name: 'Save budget' }).click()
  await expect(alice.page.getByTestId('my-budget-amount')).toHaveText(`$${amount}`)
}

/** Everything that shows Bob's view can't contain Alice's budget. */
async function expectNoBudgetLeak(bob: MultiplayerUser, baseURL: string, tripId: string, frames: string[]) {
  // His page's own useQuery('budgets') received no rows (he has no budget).
  await expect(bob.page.getByTestId('budget-panel')).toHaveAttribute('data-budget-rows', '0')
  await expect(bob.page.locator('body')).not.toContainText(String(BUDGET))
  // No WebSocket frame carried a budget row. (The room's schema listing names the
  // `maxUsd` column, so that one message type is skipped; the amount is checked everywhere.)
  const dataFrames = frames.filter((f) => !f.startsWith('{"type":"records.list_schemas"'))
  expect(frames.length).toBeGreaterThan(dataFrames.length) // the capture really saw the socket
  expect(dataFrames.filter((f) => f.includes('maxUsd'))).toEqual([])
  expect(frames.filter((f) => f.includes(String(BUDGET)))).toEqual([])
  // A second client read path (agent tools, RBAC on): no budget rows, scoped or not.
  for (const where of [{ tripId }, undefined]) {
    const res = await asClient(bob, baseURL, 'records_query', { collection: 'budgets', ...(where ? { where } : {}) })
    expect(res.status).toBe(200)
    expect(res.body.result?.data?.records ?? []).toEqual([])
  }
}

test('Alice creates a trip, Bob joins by invite link, Bob’s airports show up live for Alice', async ({
  users,
}) => {
  const [alice, bob] = await users(2)
  const name = testTripName('e2e')

  await alice.page.goto('/trips')
  await alice.page.getByLabel('Trip name').fill(name)
  await alice.page.getByLabel('Outbound date').fill(futureDate(30))
  await alice.page.getByLabel('Return date').fill(futureDate(33))
  await alice.page.getByRole('button', { name: 'Create trip' }).click()
  await expect(alice.page).toHaveURL(/\/t\/[\w-]+$/)
  await expect(alice.page.getByTestId('trip-name')).toHaveText(name)
  const tripPath = new URL(alice.page.url()).pathname
  const invite = await alice.page.getByTestId('invite-link').inputValue()

  await bob.page.goto(new URL(invite).pathname)
  await expect(bob.page.getByTestId('invite-trip-name')).toHaveText(name)
  await bob.page.getByRole('button', { name: 'Join trip' }).click()
  await expect(bob.page).toHaveURL(new RegExp(`${tripPath}$`))

  // Alice's open page gains Bob without a reload.
  await expect(alice.page.getByTestId('crew-member')).toHaveCount(2)

  await bob.page.locator('#your-airports').fill('BNA')
  await bob.page.getByRole('option', { name: /^BNA/ }).click()
  await bob.page.getByRole('button', { name: 'Save settings' }).click()
  await expect(bob.page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()

  const bobOnAlicesPage = alice.page.getByTestId('crew-member').filter({ hasText: 'BNA' })
  await expect(bobOnAlicesPage).toContainText('airports set')
  expect(new URL(alice.page.url()).pathname).toBe(tripPath) // still the same page: live, not a reload
  await expect(alice.page.getByRole('link', { name: 'Trips' }).first()).toBeVisible()
})

test('Alice’s budget never reaches Bob (set after he joined)', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  await Promise.all([openApp(alice), openApp(bob)])
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('budget'))
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode })).toMatchObject({ success: true })

  const frames = captureSocketFrames(bob)
  await Promise.all([alice.page.goto(`/t/${tripId}`), bob.page.goto(`/t/${tripId}`)])
  await expect(bob.page.getByTestId('crew-member')).toHaveCount(2)

  await setBudget(alice, BUDGET)

  // Bob sees that Alice set one — live — and nothing more.
  const aliceOnBobsPage = bob.page.locator('[data-testid="crew-member"]:not([data-me])')
  await expect(aliceOnBobsPage).toContainText('budget set ✓')
  await expectNoBudgetLeak(bob, baseURL!, tripId, frames)

  // Control: the same probe does return Alice's own row to Alice.
  const own = await asClient(alice, baseURL!, 'records_query', { collection: 'budgets', where: { tripId } })
  expect(own.body.result?.data?.records?.map((r) => r.data.maxUsd)).toEqual([BUDGET])
})

test('a member who joins after Alice set her budget still can’t see it', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  await Promise.all([openApp(alice), openApp(bob)])
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('late-join'))
  await alice.page.goto(`/t/${tripId}`)
  await setBudget(alice, BUDGET)

  const frames = captureSocketFrames(bob)
  await bob.page.goto(`/join/${inviteCode}`)
  await bob.page.getByRole('button', { name: 'Join trip' }).click()
  await expect(bob.page).toHaveURL(new RegExp(`/t/${tripId}$`))

  const aliceOnBobsPage = bob.page.locator('[data-testid="crew-member"]:not([data-me])')
  await expect(aliceOnBobsPage).toContainText('budget set ✓')
  await expectNoBudgetLeak(bob, baseURL!, tripId, frames)
})

test('a non-member gets not-found for the trip URL', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  const name = testTripName('private')
  const { tripId } = await createTripApi(alice, baseURL!, name)

  const frames = captureSocketFrames(bob)
  await bob.page.goto(`/t/${tripId}`)
  await expect(bob.page.getByTestId('trip-not-found')).toBeVisible({ timeout: 15_000 })
  await expect(bob.page.locator('body')).not.toContainText(name)
  expect(frames.some((f) => f.includes(name))).toBe(false)

  // Control: the organizer does see it.
  await alice.page.goto(`/t/${tripId}`)
  await expect(alice.page.getByTestId('trip-name')).toHaveText(name)
})

test('invite page: wrong code, locked trip and full trip each explain themselves', async ({
  users,
  baseURL,
}) => {
  const [alice, bob] = await users(2)

  await bob.page.goto('/join/WrongCode12345')
  await expect(bob.page.getByTestId('join-error')).toContainText('doesn’t match a trip')

  // Locked (via the test-only lock; the real lockTrip comes later).
  const locked = await createTripApi(alice, baseURL!, testTripName('locked'))
  expect(await act(alice, baseURL!, '__testLockTrip', { tripId: locked.tripId })).toMatchObject({ success: true })
  await bob.page.goto(`/join/${locked.inviteCode}`)
  await expect(bob.page.getByTestId('join-error')).toContainText('This trip is locked')
  await expect(bob.page.getByRole('button', { name: 'Join trip' })).toHaveCount(0)
  // The action refuses too, not just the page.
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode: locked.inviteCode })).toMatchObject({
    success: false,
    code: 'trip_locked',
  })

  // Full: organizer + 7 ghosts = 8.
  const full = await createTripApi(alice, baseURL!, testTripName('full'))
  for (let i = 0; i < 7; i++) {
    const res = await act(alice, baseURL!, 'addGhost', {
      tripId: full.tripId,
      displayName: `Ghost ${i}`,
      homeAirports: ['ORD'],
    })
    expect(res).toMatchObject({ success: true })
  }
  await bob.page.goto(`/join/${full.inviteCode}`)
  await expect(bob.page.getByTestId('join-error')).toContainText('This trip is full')
})

test('organizer adds, edits and removes a ghost; Bob sees each change live', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('ghosts'))
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode })).toMatchObject({ success: true })
  await Promise.all([alice.page.goto(`/t/${tripId}`), bob.page.goto(`/t/${tripId}`)])

  // Members who aren't the organizer get no ghost controls.
  await expect(bob.page.getByTestId('crew-member')).toHaveCount(2)
  await expect(bob.page.getByRole('button', { name: 'Add traveler' })).toHaveCount(0)

  await alice.page.getByRole('button', { name: 'Add traveler' }).click()
  await alice.page.getByLabel('Name').fill('Grandpa Joe')
  await alice.page.locator('#ghost-airports').fill('ORD')
  await alice.page.getByRole('option', { name: /^ORD/ }).click()
  await alice.page.getByRole('button', { name: 'Add traveler', exact: true }).last().click()

  const ghostForBob = bob.page.getByTestId('crew-member').filter({ hasText: 'Grandpa Joe' })
  await expect(ghostForBob).toContainText('Ghost')
  await expect(ghostForBob).toContainText('ORD')
  await expect(ghostForBob).not.toContainText('budget set')

  await alice.page.getByRole('button', { name: 'Edit Grandpa Joe' }).click()
  await alice.page.getByLabel('Name').fill('Grandma Jo')
  await alice.page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(bob.page.getByTestId('crew-member').filter({ hasText: 'Grandma Jo' })).toBeVisible()

  await alice.page.getByRole('button', { name: 'Remove Grandma Jo' }).click()
  await alice.page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(bob.page.getByTestId('crew-member')).toHaveCount(2)
})

test('the usage ledger is invisible and unwritable for both users', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  await Promise.all([openApp(alice), openApp(bob)])
  // A normal-named trip is counted in `usage` (trips:created:user:<alice>). Either it is
  // created (the row now exists) or Alice is at today's cap (the row exists with 10).
  const created = await act(alice, baseURL!, 'createTrip', {
    name: `Usage probe ${Date.now().toString(36)}`,
    outboundDate: futureDate(40),
    returnDate: futureDate(42),
  })
  expect(created.success || created.code === 'cap_reached').toBe(true)

  for (const user of [alice, bob]) {
    const read = await asClient(user, baseURL!, 'records_query', { collection: 'usage' })
    expect(read.status).toBe(200)
    expect(read.body.result?.data?.records ?? []).toEqual([])
    const write = await asClient(user, baseURL!, 'records_create', {
      collection: 'usage',
      data: { day: futureDate(0), key: 'serpapi:global', count: 0 },
    })
    expect(write.body.ok).toBe(false)
    expect(write.body.error).toContain('CREATE DENIED')
  }
})
