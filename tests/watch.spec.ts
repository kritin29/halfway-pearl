/**
 * Phase 7 two-user flow (SPEC §3.9, §6 checkFaresNow, §10 Book): on a
 * `__test-` trip with results, both open the Book tab's fare watch; Alice
 * (organizer) clicks "Check fares now", the job writes a fareSnapshots row,
 * and both sparklines gain a point live. The 4th check of the day is refused
 * with an error. Alice turns the daily watch off and Bob sees it. After a
 * lock, the watch follows the locked destination.
 *
 * No paid calls: `__test-` trips get fixture fares, and any watch email is
 * built but mocked at the email/send boundary (src/server/email-source.ts).
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { act, createTripApi, setOwnAirports, testTripName, waitForTrip } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)
test.describe.configure({ timeout: 150_000 })

test('Check fares now writes a snapshot and both sparklines gain a point; caps, toggle and lock', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('watch'))
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode })).toMatchObject({ success: true })
  await setOwnAirports(alice, baseURL!, tripId, ['ORD'])
  await setOwnAirports(bob, baseURL!, tripId, ['BOS'])
  for (const iata of ['BNA', 'AUS']) {
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata }), iata).toMatchObject({ success: true })
  }
  // No results yet: nothing to watch.
  expect(await act(alice, baseURL!, 'checkFaresNow', { tripId })).toMatchObject({ success: false, code: 'not_ready' })

  expect(await act(alice, baseURL!, 'startSearch', { tripId })).toMatchObject({ success: true })
  await waitForTrip(alice, baseURL!, tripId, (t) => t.status === 'results')
  // Bob's vote puts Austin at the top of the shortlist.
  expect(await act(bob, baseURL!, 'toggleVote', { tripId, iata: 'AUS' })).toMatchObject({ success: true })

  await Promise.all([alice.page.goto(`/t/${tripId}`), bob.page.goto(`/t/${tripId}`)])
  for (const user of [alice, bob]) {
    await user.page.getByRole('tab', { name: 'Book' }).click()
    await expect(user.page.getByTestId('watch-history')).toHaveAttribute('data-iata', 'AUS', { timeout: 15_000 })
    // The full search's snapshot is the first point.
    await expect(user.page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '1')
    await expect(user.page.getByTestId('watch-last-checked')).toContainText('Last checked')
  }
  // Only the organizer gets the controls; Bob sees the watch's state.
  await expect(bob.page.getByTestId('check-fares-now')).toHaveCount(0)
  await expect(bob.page.getByTestId('watch-status')).toContainText('On: Halfway checks fares every morning')
  expect(await act(bob, baseURL!, 'checkFaresNow', { tripId })).toMatchObject({ success: false, code: 'forbidden' })

  // Alice checks now: a snapshot lands and both sparklines gain a point, live.
  await alice.page.getByTestId('check-fares-now').click()
  for (const user of [alice, bob]) {
    await expect(user.page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '2', { timeout: 30_000 })
  }
  await expect(alice.page.getByTestId('watch-last-checked')).toHaveText('Last checked just now')
  await expect(alice.page.getByTestId('check-fares-now')).toBeEnabled()
  await expect(alice.page.getByTestId('watch-error')).toHaveCount(0)

  // Two more checks use up the day's 3; the 4th click shows the refusal.
  for (let i = 0; i < 2; i++) {
    expect(await act(alice, baseURL!, 'checkFaresNow', { tripId })).toMatchObject({ success: true })
    await waitForTrip(alice, baseURL!, tripId, (t) => !t.watchQueuedAt)
  }
  await expect(bob.page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '4', { timeout: 15_000 })
  await alice.page.getByTestId('check-fares-now').click()
  await expect(alice.page.getByTestId('check-fares-error')).toContainText('already checked 3 times today')

  // Alice turns the daily watch off; Bob sees it live. Then back on.
  await alice.page.getByTestId('watch-toggle').getByRole('switch').click()
  await expect(bob.page.getByTestId('watch-status')).toContainText('Off: no daily checks or emails.')
  await alice.page.getByTestId('watch-toggle').getByRole('switch').click()
  await expect(bob.page.getByTestId('watch-status')).toContainText('On:')

  // After a lock, the watch follows the locked destination: its own history (the search + 3 watch runs, which snapshot the whole shortlist).
  expect(await act(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })).toMatchObject({ success: true })
  await expect(bob.page.getByTestId('watch-history')).toHaveAttribute('data-iata', 'BNA', { timeout: 15_000 })
  await expect(bob.page.getByTestId('fare-sparkline')).toHaveAttribute('data-points', '4')
})
