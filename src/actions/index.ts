import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { addGhost, removeGhost, updateGhost } from './ghosts'
import { createTrip, joinTrip, previewInvite, testLockTrip } from './trips'

/**
 * Every action is exposed at POST /api/actions/<name> (src/server/action-routes.ts)
 * and runs with RBAC off: each one validates params and checks the trip itself.
 */
export const actions: Record<string, ActionHandler<Env>> = {
  createTrip,
  joinTrip,
  previewInvite,
  addGhost,
  updateGhost,
  removeGhost,
  // Test-only; refuses everything unless ALLOW_DEBUG_ROUTES === 'true' (src/server/test-seam.ts).
  __testLockTrip: testLockTrip,
}
