/**
 * One RBAC-off tools factory for server actions, background jobs and cron
 * (SPEC §4, NOTES §2). Moved out of the scaffold's action-routes.ts unchanged.
 *
 * Trust model: the tools reach the app's RecordRoom with `X-App-Action: true`,
 * which turns per-record RBAC OFF. `actingUserId` is the identity the writes
 * are stamped with (`createdBy`, `userBound` columns), not a permission check.
 * Every caller must authorize the request itself before calling `tools.*`.
 *
 * - Actions: `createAppTools(env, auth.userId, callerJwt)`.
 * - Jobs / cron: `createAppTools(env, env.OWNER_USER_ID)` (no caller JWT, so
 *   user-billed integrations can't work there; ours are all developer-billed).
 *
 * Records always go to the room `app:${env.DEEPSPACE_APP_ID}`, never the
 * `"default"` room `buildCronContext` falls back to.
 */

import {
  apiWorkerFetch,
  lookupOwn,
  normalizeApiError,
  splitIntegrationEndpoint,
} from 'deepspace/worker'
import type { ActionResult, ActionTools } from 'deepspace/worker'
import { integrations } from '../integrations.js'
import type { Env } from '../../worker.js'

export function createAppTools(env: Env, actingUserId: string, callerJwt = ''): ActionTools {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))

  // The DO returns ActionResult<unknown>; callers below supply the precise
  // operation result type fixed by the SDK tools-api wire contract.
  async function execTool<TData>(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult<TData>> {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': actingUserId,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({ tool, params }),
      }),
    )
    return res.json() as Promise<ActionResult<TData>>
  }

  async function callIntegration<T>(endpoint: string, data?: unknown): Promise<ActionResult<T>> {
    // "name/endpoint", both plain identifiers: anything else could reach
    // another api-worker route carrying the owner's token.
    const target = splitIntegrationEndpoint(endpoint)
    if (!target) {
      return {
        success: false,
        code: 'invalid_integration_endpoint',
        error: `Integration endpoint ${JSON.stringify(endpoint)} must be "<integration>/<endpoint>"`,
      }
    }
    const integrationName = target.name
    const billingMode = lookupOwn(integrations, integrationName)?.billing ?? 'developer'

    // The api-worker bills the JWT subject: owner for developer mode, caller
    // for user mode. It does not accept a client-supplied billing override.
    const jwt = billingMode === 'developer' ? env.APP_OWNER_JWT : callerJwt
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    }

    // Composio files connections per app, so identify this app as the
    // /api/integrations proxy does; otherwise an action looks for the user's
    // connection in a different namespace. Pre-first-deploy there is no token:
    // omit both and let the api-worker fail closed.
    if (integrationName === 'composio' && env.APP_IDENTITY_TOKEN) {
      headers['x-app-identity-token'] = env.APP_IDENTITY_TOKEN
      headers['x-app-id'] = env.DEEPSPACE_APP_ID
    }

    const res = await apiWorkerFetch(env, target.path, {
      method: 'POST',
      headers,
      body: JSON.stringify(data ?? {}),
    })
    const payload = (await res.json()) as Record<string, unknown>
    if (!res.ok || payload.success === false) {
      return { success: false, ...normalizeApiError(res.status, payload) }
    }
    return payload as ActionResult<T>
  }

  return {
    create: (collection, data, recordId) =>
      execTool('records.create', { collection, data, recordId }),
    update: (collection, recordId, data) =>
      execTool('records.update', { collection, recordId, data }),
    remove: (collection, recordId) => execTool('records.delete', { collection, recordId }),
    deleteWhere: (collection, where, limit) =>
      execTool('records.deleteWhere', { collection, where, limit }),
    get: (collection, recordId) => execTool('records.get', { collection, recordId }),
    query: (collection, options) => execTool('records.query', { collection, ...options }),
    integration: callIntegration,
    registerUser: (options) => execTool('users.register', { ...options }),
  }
}
