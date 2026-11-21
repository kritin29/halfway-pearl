/**
 * toggleVote (SPEC §6, §3.7): approval voting, any member, any number of
 * destinations. The caller is always the subject (`votes.userId` is
 * `userBound`, stamped from the verified JWT, never from params).
 */
import type { Env } from '../../worker'
import { iata, recordId } from '../lib/validate'
import { defineAction, fail, isDuplicate, loadTrip, must, ok, requireMember } from '../server/trip-access'
import { sameIds } from '../server/trip-rows'

export const toggleVote = defineAction<Env>('toggleVote', async ({ userId, params, tools }) => {
  const tripId = recordId(params.tripId, 'Trip')
  if (!tripId.ok) return fail('invalid_params', tripId.error)
  const access = await requireMember(tools, tripId.value, userId)
  if (!access.ok) return access.result
  // Format only: a destination already on the list stays votable even if it left airports.json.
  const code = iata(params.iata, 'Destination', () => true)
  if (!code.ok) return fail('invalid_params', code.error)
  if (access.trip.data.status === 'locked') return fail('trip_locked', 'This trip is locked, so voting is closed.')

  const { records: candidates } = must(
    await tools.query('candidates', { where: { tripId: tripId.value, iata: code.value }, limit: 1 }),
    'find candidate',
  )
  if (!candidates[0]) return fail('not_found', `${code.value} isn’t on the list.`)

  const { records: mine } = must(
    await tools.query('votes', { where: { tripId: tripId.value, userId, candidateIata: code.value }, limit: 1 }),
    'find vote',
  )
  if (mine[0]) {
    must(await tools.remove('votes', mine[0].recordId), 'remove vote')
    return ok({ iata: code.value, voted: false })
  }

  const res = await tools.create('votes', {
    tripId: tripId.value,
    memberIds: [...access.trip.data.memberIds],
    userId,
    candidateIata: code.value,
  })
  // A double click got there first: the vote exists, which is what was asked.
  if (!res.success && isDuplicate(res)) return ok({ iata: code.value, voted: true })
  const { recordId: voteId } = must(res, 'create vote')

  // Someone may have joined while we wrote; match the trip's current members.
  const fresh = await loadTrip(tools, tripId.value)
  if (fresh.ok && !sameIds(fresh.trip.data.memberIds, access.trip.data.memberIds)) {
    must(await tools.update('votes', voteId, { memberIds: [...fresh.trip.data.memberIds] }), 'update vote members')
  }
  return ok({ iata: code.value, voted: true })
})
