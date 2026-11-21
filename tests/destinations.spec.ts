/**
 * Phase 4 two-user flows (SPEC §3.4, §6): destinations added by one member
 * show up live for the other; members can add but not remove or ask the AI;
 * the geographic middle; the 6-destination limit.
 *
 * No test here reaches a paid integration: the only suggestCandidates calls
 * are Bob's, which are refused (forbidden) before any AI call. The one real
 * AI call lives in api.spec.ts.
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'
import { act, createTripApi, testTripName } from './helpers/trips'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)
test.describe.configure({ timeout: 90_000 })

/** Alice's trip with Bob on it. */
async function sharedTrip(alice: MultiplayerUser, bob: MultiplayerUser, baseURL: string, label: string) {
  const trip = await createTripApi(alice, baseURL, testTripName(label))
  expect(await act(bob, baseURL, 'joinTrip', { inviteCode: trip.inviteCode })).toMatchObject({ success: true })
  return trip
}

/** Open the trip's Destinations tab and wait for the list to load. */
async function openDestinations(user: MultiplayerUser, tripId: string) {
  await user.page.goto(`/t/${tripId}`)
  await user.page.getByRole('tab', { name: 'Destinations' }).click()
  await expect(user.page.getByTestId('candidate-count')).toBeVisible({ timeout: 15_000 })
}

/** Add a destination through the search box. */
async function addViaSearch(user: MultiplayerUser, query: string, code: string) {
  const input = user.page.getByLabel('Add a destination')
  await expect(input).toBeEnabled()
  await input.fill(query)
  await user.page.getByRole('option', { name: new RegExp(`^${code}`) }).click()
}

const candidate = (user: MultiplayerUser, code: string) =>
  user.page.locator(`[data-testid="candidate"][data-iata="${code}"]`)

test('Alice adds a destination and Bob sees it live; Bob can add but not remove or ask the AI', async ({
  users,
  baseURL,
}) => {
  const [alice, bob] = await users(2)
  const { tripId } = await sharedTrip(alice, bob, baseURL!, 'dest-live')
  await openDestinations(alice, tripId)
  await openDestinations(bob, tripId)
  await expect(bob.page.getByTestId('destinations-empty')).toBeVisible()

  // Alice adds Nashville by search; Bob's open page gets it without a reload.
  await addViaSearch(alice, 'Nashville', 'BNA')
  await expect(candidate(bob, 'BNA')).toBeVisible()
  await expect(candidate(bob, 'BNA')).toContainText('Nashville')
  await expect(candidate(bob, 'BNA').getByTestId('candidate-source')).toHaveText('Manual')
  await expect(bob.page.getByTestId('candidate-count')).toHaveText('(1/6)')

  // Bob has no organizer controls.
  await expect(bob.page.getByRole('button', { name: 'Suggest with AI' })).toHaveCount(0)
  await expect(bob.page.getByRole('button', { name: 'Add geographic middle' })).toHaveCount(0)
  await expect(bob.page.getByRole('button', { name: 'Remove BNA' })).toHaveCount(0)
  await expect(alice.page.getByRole('button', { name: 'Remove BNA' })).toBeVisible()
  // Find fares is visible but not usable yet.
  await expect(bob.page.getByRole('button', { name: /Find fares/ })).toBeDisabled()

  // Bob adds Austin; Alice sees it live, credited to Bob.
  await addViaSearch(bob, 'AUS', 'AUS')
  await expect(candidate(alice, 'AUS')).toBeVisible()
  await expect(candidate(bob, 'AUS')).toContainText('Added by you')

  // Calling the organizer actions directly is refused, and nothing changes.
  for (const [name, params] of [
    ['removeCandidate', { tripId, iata: 'BNA' }],
    ['suggestCandidates', { tripId }],
    ['addMidpointHubs', { tripId }],
  ] as const) {
    expect(await act(bob, baseURL!, name, params), name).toMatchObject({ success: false, code: 'forbidden' })
  }
  await expect(alice.page.getByTestId('candidate')).toHaveCount(2)

  // Alice removes Austin; it disappears from Bob's page.
  await alice.page.getByRole('button', { name: 'Remove AUS' }).click()
  await alice.page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(candidate(bob, 'AUS')).toHaveCount(0)
  await expect(candidate(bob, 'BNA')).toBeVisible()
})

test('organizer adds the geographic middle; Bob sees the hubs live', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  const { tripId } = await sharedTrip(alice, bob, baseURL!, 'dest-middle')
  for (const [displayName, homeAirports] of [
    ['Chicago friend', ['ORD']],
    ['Boston friend', ['BOS']],
  ] as const) {
    expect(await act(alice, baseURL!, 'addGhost', { tripId, displayName, homeAirports })).toMatchObject({
      success: true,
    })
  }
  await openDestinations(alice, tripId)
  await openDestinations(bob, tripId)

  await alice.page.getByRole('button', { name: 'Add geographic middle' }).click()
  await expect(bob.page.getByTestId('candidate')).toHaveCount(2)
  for (const source of await bob.page.getByTestId('candidate-source').allTextContents()) {
    expect(source).toBe('Middle')
  }
  await expect(bob.page.getByTestId('candidate-why').first()).toContainText('Near the middle')
  // Home airports are never "the middle".
  await expect(candidate(bob, 'ORD')).toHaveCount(0)
  await expect(candidate(bob, 'BOS')).toHaveCount(0)
})

test('a 7th destination is refused, and duplicates too', async ({ users, baseURL }) => {
  const [alice, bob] = await users(2)
  const { tripId } = await sharedTrip(alice, bob, baseURL!, 'dest-limit')
  const six = ['BNA', 'AUS', 'DEN', 'MSY', 'MIA', 'SEA']
  for (const [i, iata] of six.entries()) {
    const res = await act(i % 2 ? bob : alice, baseURL!, 'addCandidate', { tripId, iata })
    expect(res, iata).toMatchObject({ success: true })
  }
  expect(await act(bob, baseURL!, 'addCandidate', { tripId, iata: 'SAN' })).toMatchObject({
    success: false,
    code: 'candidates_full',
  })
  expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata: 'BNA' })).toMatchObject({
    success: false,
    code: 'duplicate',
  })
  expect(await act(alice, baseURL!, 'addCandidate', { tripId, iata: 'ZZZ' })).toMatchObject({
    success: false,
    code: 'invalid_params',
  })

  await openDestinations(bob, tripId)
  await openDestinations(alice, tripId)
  await expect(bob.page.getByTestId('candidate')).toHaveCount(6)
  await expect(bob.page.getByTestId('candidate-count')).toHaveText('(6/6)')
  await expect(bob.page.getByLabel('Add a destination')).toBeDisabled()
  await expect(alice.page.getByRole('button', { name: 'Suggest with AI' })).toBeDisabled()
  await expect(alice.page.getByRole('button', { name: 'Add geographic middle' })).toBeDisabled()
})
