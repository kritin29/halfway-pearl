import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { addCandidate, addMidpointHubs, removeCandidate, suggestCandidates } from './candidates'
import { createDemoTrip } from './demo'
import { addGhost, removeGhost, updateGhost } from './ghosts'
import { lockTrip, setWatch } from './lock'
import { checkFaresNow, startSearch } from './search'
import { createTrip, joinTrip, previewInvite, testLockTrip } from './trips'
import { toggleVote } from './votes'

/**
 * Every action is exposed at POST /api/actions/<name> (src/server/action-routes.ts)
 * and runs with RBAC off: each one validates params and checks the trip itself.
 */
export const actions: Record<string, ActionHandler<Env>> = {
  createTrip,
  createDemoTrip,
  joinTrip,
  previewInvite,
  addGhost,
  updateGhost,
  removeGhost,
  addCandidate,
  removeCandidate,
  addMidpointHubs,
  suggestCandidates,
  startSearch,
  toggleVote,
  lockTrip,
  setWatch,
  checkFaresNow,
  // Test-only; refuses everything unless ALLOW_DEBUG_ROUTES === 'true' (src/server/test-seam.ts).
  __testLockTrip: testLockTrip,
}
