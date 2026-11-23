/**
 * Integration Billing Config
 *
 * Configure who pays for each integration's API calls.
 *
 * - 'developer': The app owner pays (default).
 * - 'user': The calling user pays.
 *
 * Every integration requires a signed-in caller. Set `anonymous: true` on a
 * 'developer' integration to let signed-out visitors call it too — the owner
 * then pays for anyone who can reach the app.
 *
 * Halfway: integrations not listed here are refused by the browser proxy (403),
 * and names match case-insensitively (src/server/http-routes.ts).
 *
 * IMPORTANT: any integration backed by per-user connected accounts (Google,
 * Composio) must be 'user' — the api-worker resolves the account from the
 * JWT subject. With 'developer' the app owner's JWT is forwarded, so every
 * signed-in user connects and acts on the app owner's account. Server code
 * that acts for a user in the background (e.g. a cron job) uses
 * `callComposio(env, ..., { asUser })` from 'deepspace/worker' instead.
 */

export interface IntegrationConfig {
  billing: 'developer' | 'user'
  anonymous?: boolean
  /**
   * Halfway addition (SPEC §11, NOTES C4): reachable only from server code
   * (`tools.integration` in actions/jobs/cron, after the `usage` cap checks).
   * The browser proxy `/api/integrations/:name/:endpoint` answers 403, so a
   * signed-in user can't spend the owner's credits around the caps or use
   * `email/send` as a relay.
   */
  serverOnly?: boolean
}

export const integrations: Record<string, IntegrationConfig> = {
  google: { billing: 'user' },
  composio: { billing: 'user' },
  serpapi: { billing: 'developer', serverOnly: true },
  anthropic: { billing: 'developer', serverOnly: true },
  email: { billing: 'developer', serverOnly: true },
}
