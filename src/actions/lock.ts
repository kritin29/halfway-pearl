/**
 * lockTrip and setWatch (SPEC §6, §3.8). Organizer only; RBAC is off, so the
 * checks below are the only checks.
 */
import type { Env } from '../../worker'
import { isDemoTrip } from '../lib/demo'
import { flag, iata, recordId } from '../lib/validate'
import { sendLockEmails, type LockEmailReport } from '../server/lock-emails'
import { defineAction, fail, loadTrip, must, ok, requireOrganizer } from '../server/trip-access'

/**
 * Lock a destination: only from status 'results' and only for a complete
 * candidate (everyone has a fare). Then email each real member their own
 * booking link. An email failure never undoes the lock.
 *
 * Calling it again for the SAME destination on a locked trip is the retry:
 * it sends only the emails that haven't gone out yet (emailLog claims).
 * A demo trip locks the same way but sends nothing (`emails.emailsOff`).
 */
export const lockTrip = defineAction<Env>('lockTrip', async ({ userId, params, tools, env }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  // Format only: a destination already on the list stays lockable even if it left airports.json.
  const code = iata(params.iata, 'Destination', () => true)
  if (!code.ok) return fail('invalid_params', code.error)

  const trip = access.trip
  const alreadyLocked = trip.data.status === 'locked'
  if (alreadyLocked && trip.data.lockedIata !== code.value) {
    return fail('trip_locked', `This trip is already locked to ${trip.data.lockedIata ?? 'another destination'}.`)
  }
  if (!alreadyLocked) {
    if (trip.data.status === 'searching') return fail('search_running', 'Wait for the fare search to finish first.')
    if (trip.data.status !== 'results') {
      return fail('not_ready', 'Find fares first: you can lock a destination once results are in.')
    }
  }

  const { records } = must(
    await tools.query('candidates', { where: { tripId: tripId.value, iata: code.value }, limit: 1 }),
    'find candidate',
  )
  const candidate = records[0]
  if (!candidate) return fail('not_found', `${code.value} isn’t on the list.`)
  const destination = {
    iata: code.value,
    city: String(candidate.data.city ?? code.value),
    country: String(candidate.data.country ?? ''),
  }

  if (!alreadyLocked) {
    if (candidate.data.complete !== 1) {
      return fail('incomplete', `Not everyone has a fare to ${destination.city} yet, so it can’t be locked.`)
    }
    must(await tools.update('trips', tripId.value, { status: 'locked', lockedIata: code.value }), 'lock trip')
    // Two clicks on different destinations at once: the last write wins, and only its call sends emails.
    const fresh = await loadTrip(tools, tripId.value)
    if (fresh.ok && fresh.trip.data.lockedIata !== code.value) {
      return fail('trip_locked', `This trip is already locked to ${fresh.trip.data.lockedIata ?? 'another destination'}.`)
    }
  }

  let emails: LockEmailReport | null = null
  try {
    emails = await sendLockEmails(tools, env, trip, destination)
  } catch (err) {
    // The lock stands; the organizer can retry the emails from the Book tab.
    console.error(`[action] lockTrip emails failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return ok({ tripId: tripId.value, iata: code.value, alreadyLocked, emails })
})

/** Turn the daily fare watch on or off (SPEC §3.9). The cron watches only trips with it on; never demo trips. */
export const setWatch = defineAction<Env>('setWatch', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const enabled = flag(params.enabled, 'Fare watch')
  if (!enabled.ok) return fail('invalid_params', enabled.error)
  const access = await requireOrganizer(tools, tripId.value, userId)
  if (!access.ok) return access.result
  if (isDemoTrip(access.trip.data)) {
    return fail('demo_trip', 'Demo trips aren’t watched daily. Use “Check fares now” to re-check the sample prices.')
  }
  must(await tools.update('trips', tripId.value, { watchEnabled: enabled.value }), 'set watch')
  return ok({ tripId: tripId.value, watchEnabled: enabled.value })
})
