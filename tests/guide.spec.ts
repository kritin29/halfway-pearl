/**
 * Phase 8: the trip page's "next step" guide follows the trip through all six
 * stages, live, on the solo path the /trips empty state suggests (one
 * organizer + 2 ghost travelers). Its buttons switch tabs.
 *
 * No paid calls: a `__test-` trip gets fixture fares and mocked lock emails.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { act, createTripApi, setOwnAirports, testTripName, waitForTrip } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 1, `Needs 1 usable test account, found ${usable}.`)
test.describe.configure({ timeout: 150_000 })

test('solo organizer with 2 ghosts: the guide walks airports → destinations → fares → vote → lock → book', async ({
  users,
  baseURL,
}) => {
  const [alice] = await users(1)
  const { tripId } = await createTripApi(alice, baseURL!, testTripName('guide'))
  const page = alice.page
  await page.goto(`/t/${tripId}`)
  const guide = page.getByTestId('next-step')
  const title = page.getByTestId('next-step-title')

  // 1. Airports: mine first, then the group.
  await expect(guide).toHaveAttribute('data-stage', 'airports', { timeout: 15_000 })
  await expect(title).toHaveText('Add your home airports')
  await setOwnAirports(alice, baseURL!, tripId, ['ORD'])
  await expect(title).toHaveText('Bring in the group')
  for (const [displayName, home] of [['Boston friend', 'BOS'], ['Denver friend', 'DEN']]) {
    expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName, homeAirports: [home] })).toMatchObject({ success: true })
  }

  // 2. Destinations, and the button switches tab.
  await expect(guide).toHaveAttribute('data-stage', 'destinations')
  await guide.getByRole('button', { name: 'Go to Destinations' }).click()
  await expect(page.getByRole('tab', { name: 'Destinations' })).toHaveAttribute('aria-selected', 'true')
  for (const iata of ['BNA', 'AUS']) {
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata }), iata).toMatchObject({ success: true })
  }

  // 3. Fares.
  await expect(title).toHaveText('Find fares')
  expect(await act(alice, baseURL!, 'startSearch', { tripId })).toMatchObject({ success: true })
  await waitForTrip(alice, baseURL!, tripId, (t) => t.status === 'results')

  // 4. Vote.
  await expect(guide).toHaveAttribute('data-stage', 'vote', { timeout: 15_000 })
  await expect(title).toHaveText('Vote for the places you’d go')
  expect(await act(alice, baseURL!, 'toggleVote', { tripId, iata: 'BNA' })).toMatchObject({ success: true })

  // 5. Lock.
  await expect(guide).toHaveAttribute('data-stage', 'lock')
  await expect(title).toHaveText('Lock the destination')
  expect(await act(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })).toMatchObject({ success: true })

  // 6. Book, then done once I tick myself off.
  await expect(guide).toHaveAttribute('data-stage', 'book', { timeout: 15_000 })
  await expect(title).toHaveText('Book your flight')
  await guide.getByRole('button', { name: 'Go to Book' }).click()
  await page.getByRole('button', { name: 'I’ve booked my flight' }).click()
  await expect(title).toHaveText('You’re booked')
  await expect(guide).toContainText('1 of 3 booked')
})
