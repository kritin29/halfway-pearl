/**
 * Phase 6 two-user flow (SPEC §3.8, §6 lockTrip, §10 Book): Alice locks a
 * destination from the Results tab (with a confirm step), both see the Book
 * tab, Bob marks himself booked and Alice sees it live, the organizer ticks
 * the ghost, votes close, and joining a locked trip is refused.
 *
 * No paid calls: `__test-` trips get fixture fares, and their booking emails
 * are built but mocked at the email/send boundary (src/server/email-source.ts);
 * lockTrip reports `mocked: true`. The single real email call lives in
 * api.spec.ts.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { act, createTripApi, setOwnAirports, testTripName, waitForTrip } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)
test.describe.configure({ timeout: 150_000 })

test('Alice locks; both see Book; Bob books and Alice sees it live; ghost ticked by the organizer; joining is refused', async ({
  users,
  baseURL,
}) => {
  const [alice, bob] = await users(2)
  const { tripId, inviteCode } = await createTripApi(alice, baseURL!, testTripName('book'))
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode })).toMatchObject({ success: true })
  await setOwnAirports(alice, baseURL!, tripId, ['ORD'])
  await setOwnAirports(bob, baseURL!, tripId, ['BOS'])
  expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName: 'Denver friend', homeAirports: ['DEN'] })).toMatchObject({
    success: true,
  })
  for (const iata of ['BNA', 'AUS']) {
    expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata }), iata).toMatchObject({ success: true })
  }

  // Nobody can lock before there are results.
  expect(await act(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })).toMatchObject({ success: false, code: 'not_ready' })

  await Promise.all([alice.page.goto(`/t/${tripId}`), bob.page.goto(`/t/${tripId}`)])
  await expect(alice.page.getByRole('tab', { name: 'Book' })).toBeDisabled({ timeout: 15_000 })
  expect(await act(alice, baseURL!, 'startSearch', { tripId })).toMatchObject({ success: true })
  await waitForTrip(alice, baseURL!, tripId, (t) => t.status === 'results')

  for (const user of [alice, bob]) {
    await user.page.getByRole('tab', { name: 'Results' }).click()
    await expect(user.page.locator('[data-testid="result-card"][data-complete="1"]')).toHaveCount(2, { timeout: 30_000 })
  }
  // Only the organizer gets the lock button.
  await expect(alice.page.getByTestId('lock-button')).toHaveCount(2)
  await expect(bob.page.getByTestId('lock-button')).toHaveCount(0)
  expect(await act(bob, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })).toMatchObject({ success: false, code: 'forbidden' })

  // Alice locks Nashville, with a confirm step (cancel first: nothing happens).
  const bnaCard = alice.page.locator('[data-testid="result-card"][data-iata="BNA"]')
  await bnaCard.getByTestId('lock-button').click()
  await expect(alice.page.getByRole('dialog')).toContainText('Lock Nashville (BNA)?')
  await alice.page.getByRole('button', { name: 'Cancel' }).click()
  await expect(alice.page.getByRole('dialog')).toHaveCount(0)
  await expect(bob.page.getByRole('tab', { name: 'Book' })).toBeDisabled()

  await bnaCard.getByTestId('lock-button').click()
  await alice.page.getByRole('button', { name: 'Lock and email everyone' }).click()
  // Two real members get an email (mocked at the boundary here); the ghost doesn't.
  await expect(alice.page.getByText('Booking emails sent to 2 travelers.')).toBeVisible({ timeout: 15_000 })
  await expect(alice.page.getByTestId('locked-destination')).toHaveAttribute('data-iata', 'BNA')

  // Bob's page goes live without a reload: it moves to the now-enabled Book tab
  // (he hadn't picked a tab), Results marks the card Locked, and votes are closed.
  await expect(bob.page.getByRole('tab', { name: 'Book' })).toBeEnabled({ timeout: 15_000 })
  await expect(bob.page.getByTestId('locked-destination')).toContainText('Nashville')
  await bob.page.getByRole('tab', { name: 'Results' }).click()
  await expect(bob.page.locator('[data-testid="result-card"][data-iata="BNA"]').getByTestId('locked-badge')).toBeVisible()
  await expect(bob.page.getByTestId('lock-button')).toHaveCount(0)
  for (const button of await bob.page.getByTestId('vote-button').all()) await expect(button).toBeDisabled()
  await bob.page.getByRole('tab', { name: 'Book' }).click()
  await expect(bob.page.getByTestId('locked-destination')).toHaveAttribute('data-iata', 'BNA')
  await expect(bob.page.getByTestId('your-fare')).toContainText('$')
  await expect(bob.page.getByTestId('your-booking-link')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/travel\/flights/)
  await expect(bob.page.getByTestId('booked-count')).toHaveText('0 of 3 booked')

  // Bob can tick only himself; Alice can tick the ghost but not Bob.
  const row = (user: typeof alice, name: string) =>
    user.page.locator(`[data-testid="checklist-row"][data-traveler="${name}"]`)
  await expect(row(bob, 'Denver friend').getByRole('button')).toHaveCount(0)
  await expect(row(alice, 'Bob').getByRole('button')).toHaveCount(0)

  await bob.page.getByRole('button', { name: 'I’ve booked my flight' }).click()
  await expect(row(alice, 'Bob')).toHaveAttribute('data-booked', '1')
  await expect(alice.page.getByTestId('booked-count')).toHaveText('1 of 3 booked')

  await alice.page.getByRole('button', { name: 'Mark Denver friend as booked' }).click()
  await expect(bob.page.getByTestId('booked-count')).toHaveText('2 of 3 booked')
  await expect(row(bob, 'Denver friend')).toHaveAttribute('data-booked', '1')

  // Bob changes his mind; Alice sees that live too.
  await bob.page.getByRole('button', { name: 'Mark me as not booked' }).click()
  await expect(alice.page.getByTestId('booked-count')).toHaveText('1 of 3 booked')

  // The watch toggle is shown to the organizer, labelled as coming next, and inert.
  await expect(alice.page.getByTestId('watch-toggle')).toContainText('Daily fare watch: coming next')
  await expect(alice.page.getByTestId('watch-toggle').getByRole('switch')).toBeDisabled()
  await expect(bob.page.getByTestId('watch-toggle')).toHaveCount(0)

  // A retry of the lock emails nobody twice.
  const retry = await act<{ emails: Record<string, unknown> }>(alice, baseURL!, 'lockTrip', { tripId, iata: 'BNA' })
  expect(retry.data!.emails).toMatchObject({ sent: 0, alreadySent: 2, mocked: true })
  expect(await act(alice, baseURL!, 'lockTrip', { tripId, iata: 'AUS' })).toMatchObject({ success: false, code: 'trip_locked' })

  // Joining a locked trip is refused: Alice locks a second trip Bob isn't on.
  const other = await createTripApi(alice, baseURL!, testTripName('book-join'))
  await setOwnAirports(alice, baseURL!, other.tripId, ['ORD'])
  expect(await act(alice, baseURL!, 'addGhost', { tripId: other.tripId, displayName: 'Ghost', homeAirports: ['DEN'] })).toMatchObject({
    success: true,
  })
  expect(await act(alice, baseURL!, 'addCandidate', { tripId: other.tripId, iata: 'BNA' })).toMatchObject({ success: true })
  expect(await act(alice, baseURL!, 'startSearch', { tripId: other.tripId })).toMatchObject({ success: true })
  await waitForTrip(alice, baseURL!, other.tripId, (t) => t.status === 'results')
  expect(await act(alice, baseURL!, 'lockTrip', { tripId: other.tripId, iata: 'BNA' })).toMatchObject({ success: true })

  await bob.page.goto(`/join/${other.inviteCode}`)
  await expect(bob.page.getByTestId('join-error')).toContainText('This trip is locked')
  await expect(bob.page.getByRole('button', { name: 'Join trip' })).toHaveCount(0)
  expect(await act(bob, baseURL!, 'joinTrip', { inviteCode: other.inviteCode })).toMatchObject({
    success: false,
    code: 'trip_locked',
  })
})
