# Agent log

This becomes your submission writeup. Keep it honest and short. Add an entry per phase.

Format:

## Phase N — <title> — <date/time>
**Agent (Claude Code) did:**
- …
**Agent got wrong / I corrected:**
- …
**I verified myself (how):**
- …
**Decisions & tradeoffs:**
- …

---

## Planning — Fri Nov 20
**Agent (Claude, chat) did:** researched DeepSpace docs, SDK package, and example apps; checked competitors; drafted SPEC.md, CLAUDE.md, PROMPTS.md.
**I decided:** the idea (group meet-up planner), the differentiators (private budgets, fare watch, arrival alignment), GitHub as source authority, …
**I verified myself:** …

---

## Phase 1 — Orientation: DeepSpace research → NOTES.md — Fri Nov 20
**Agent (Claude Code) did:**
- Read CLAUDE.md, AGENTS.md, SPEC.md, the 9 required docs pages, the scaffold (worker, schemas, actions, action/realtime/http routes, jobs, cron, integrations, (app) layout, tests), `deepspace@0.44.2` `.d.ts` files, and the bundled runtime where the types were silent. Ran the free `integrations info` for serpapi/anthropic/email.
- Wrote NOTES.md: 12 conflicts/gaps with quotes and file:line citations, answers to the 6 questions, a whole-project file list, and 5 decisions for the developer.
- No app code written. SPEC.md not changed yet (waiting for approval per CLAUDE.md).
**What broke / surprised me:**
- `userBound` stamps the acting user id even on RBAC-off server writes, so ghost travelers can't use it.
- The owner is always `admin`, and the spec's permission blocks omit admin, so the developer would be locked out of budgets/travelers.
- JobRoom by default lets any member read/enqueue jobs. The browser integration proxy lets any signed-in user call serpapi/email billed to the owner, bypassing caps.
- `email/send` ignores `from` (catalog), which contradicts the docs page.
**Unsure about:**
- Whether a stray `/ws/cron/<other-id>` room arms its own schedule (inferred from code+docs, not run).
- Whether `memberIds` changes broadcast newly visible rows live to a joining member (should; needs e2e).
- Exact agent tool name for `records.query` on `/_deepspace/agent/tools/*` (check `GET /_deepspace/agent/tools`).
**I verified myself (how):**
- …
- Opened node_modules/deepspace/dist/worker.js lines 1543–1545: on create, a userBound column
  is overwritten with the acting user's id, even in server actions. Confirms ghost travelers
  can't use userBound (NOTES §6). Checked the code with Claude (chat).
- Ran `integrations info email/send`: the from field is ignored, $0.013/email (NOTES C5).
- Ran `integrations info anthropic/chat-completion`: the default model is Opus, 4096 tokens,
  so we must pass a cheap model explicitly (NOTES C10).
---

## Phase 2 — Real flight data and pure logic (TDD) — Fri Nov 20
**Agent (Claude Code) did:**
- Relabeled the research entry as Phase 1 (PROMPTS.md numbering), also in SPEC.md's changelog heading and the NOTES.md title.
- Made the ONE approved `serpapi/flights` call (ORD,MDW → BNA, 2026-12-11 → 12-13). It **failed upstream and was not billed**: `upstream_provider_error … SerpAPI error 429: "Your account has run out of searches."`, `billing: "released"`. That's the platform's shared SerpApi quota, not our request. Not retried. **No real flight fixture exists yet.**
- `src/data/airports.json`: 252 airports (77 `major`). Coordinates/names/countries come from OurAirports (public domain); I chose the airports, the `major` hub list, and display-city overrides (e.g. BRU "Zaventem" → "Brussels"). Build script kept at `scripts/build-airports.mjs` for provenance. PBI (Palm Beach) is missing from the OurAirports snapshot and was dropped rather than hand-typed.
- Pure modules + Vitest: `src/lib/limits.ts` (all caps/costs), `caps.ts`, `ranking.ts`, `watch.ts`, `midpoint.ts`, with tests next to each. `npx deepspace test run unit`: 6 files, 62 tests pass. `tsc --noEmit` and eslint clean.
- Mutation check: changing the privacy guard from 3 to 2 budgets makes 2 ranking tests fail (then restored).
- Follow-up (developer decisions):
  - `src/lib/flights.ts` written against SerpApi's published format (https://serpapi.com/google-flights-api, "JSON structure overview"); every field relied on is cited in the file header. Tested with a HAND-MADE fixture `src/lib/__fixtures__/serpapi-flights-sample.json` (`_note` says so) that has one itinerary per rule plus 5 malformed entries, which are skipped.
  - Home pair: candidate = a home airport → price 0, ok, 0 stops, no call (`homeFare`); ranking leaves it out of the arrival spread.
  - `classifyIntegrationFailure`: 429 / "run out of searches" → `provider_unavailable` (no retry, not counted, human message), else `error`. Tested with the real envelope saved verbatim at `src/lib/__fixtures__/serpapi-error-429.json` (nothing secret in it).
  - Live catalog (`integrations list`, 38 integrations / 221 endpoints): the only flight source is `serpapi/flights`; other travel-ish endpoints are `serpapi/hotels` and `mta/feed` (NYC subway). Nothing called.
  - SPEC.md §7/§8 + Changelog rows 17–21 updated. Unit: 7 files, 92 tests pass; tsc and eslint clean. Red-eye mutation (21→22) fails 5 tests (then restored).
**What broke:**
- SerpApi quota (above): the real call failed with a provider 429 and billing was released, so no real fixture. tsc caught `Limits` being literal types under `as const`; fixed. A shell-quoting slip lost one fixture write (nothing written); redone with the Write tool.
**Decisions & tradeoffs (approved by the developer):**
- Incomplete candidates store `groupTotal/maxFare/minFare/arrivalSpreadMin/fitsAll = null` (a partial total would look cheap); they sort last, fewest-missing first.
- Watch checks get their own cap (3 per trip per day) instead of sharing the 2 full searches; SPEC said "same caps", which would let cron + one click exhaust a trip.
- "Under budget" email = a crossing from above to at-or-below the budget vs the previous fare; no email when there's no previous price.
- Midpoint excludes every traveler's home airport (a destination equal to someone's origin would break the search).
- Usage day = UTC date.
**Unsure about:**
- Whether `usage` record ids like `2026-11-20|serpapi:global` are allowed characters (verify in Phase 3).
- The whole flights parser is unverified against real output: field names, whether the proxy wraps the body, whether `google_flights_url` is search-specific in practice.
- Whether Google honors the built `?q=Flights to BNA from MDW,ORD on … through …` booking URL (open one by hand).
- SPEC detail I chose: after `provider_unavailable`, status goes back to `results` if earlier results exist, else `gathering`.
**I verified myself (how):**
- …

---

## Phase 3a — Security foundations, data model, trip actions — Sat Nov 21
**Agent (Claude Code) did:**
- `createAppTools` moved to `src/server/app-tools.ts`, used by `action-routes.ts` (no behaviour change).
- `serpapi`/`anthropic`/`email` marked `serverOnly`; the browser integration proxy returns 403 for them (signed in or not).
- JobRoom read/write admin-only; `/ws/cron` and `/ws/jobs` 404 unless the id is `app:${DEEPSPACE_APP_ID}`; cron gives non-admins `viewer`.
- Schemas for trips, travelers, budgets, candidates, fares, votes, fareSnapshots, usage, registered; users `roster: 'read-policy'`. `src/schemas/schemas.test.ts`: permission matrix through the SDK's `canRead/canCreate/canUpdate/canDelete/checkFieldPermissions`, plus `lintSchemas` = [] (with a control proving lint does warn on a bad schema).
- `src/lib/validate.ts`, `src/lib/airports.ts`, `src/server/{trip-access,trip-rows,usage}.ts`, and an in-memory `ActionTools` fake (`src/server/testing/fake-tools.ts`) that mirrors the RecordRoom write rules (userBound, defaults, required, immutable, uniqueOn, upsert, not-found).
- Actions `createTrip`, `joinTrip`, `addGhost`, `updateGhost`, `removeGhost`, wrapped by `defineAction` (non-object params → `invalid_params`; thrown errors → generic `server_error`, details logged without params). A non-JSON body now gets 400 instead of 500.
- Tests: unit 11 files / 185 pass; smoke+api 22 pass; e2e 25 pass; tsc and eslint clean.
- Mutation checks (each made a test fail, then restored): budgets `read: true`; members given cron/job write; `addGhost` without the organizer check; `joinTrip` without the capacity check.
**What broke / surprised me:**
- My first "member can't write cron/jobs" test passed even with members given write access: Alice had no `users` row locally, so she resolved as `viewer`. Fixed by opening `/home` first (NOTES G4).
- The room itself 404s a non-upgrade GET (`Not Found` vs the route's `Not found`), so the room-pinning tests use real browser WebSockets instead.
- An equivalent mutation (`'own'` → `'collaborator'` on budgets, which has no collaboratorsField) didn't fail any test, which is correct; switched to `read: true`.
- I committed the schemas without `limits.ts`/`types.ts` they import; amended that local, unpushed commit.
**Decisions & tradeoffs (please confirm):**
- `memberIds` is derived from the trip's real traveler rows + organizer (each insert is atomic under `uniqueOn`), then propagated; `syncTripMembers` re-reads and repeats (≤ 3 rounds) so two people joining at once converge. Last-seat race: the newer row (by createdAt, then id) backs out with `trip_full`.
- A non-member gets `not_found` for a trip that exists (same as a missing trip), so trip ids can't be probed. A member who isn't the organizer gets `forbidden`.
- Joining is allowed in any trip status (including locked). Ghost edits are allowed in any status.
- No per-user trip-creation cap: `limits.ts` has none and createTrip spends nothing. Unbounded trip creation is possible (abuse, not spend).
- Trip dates: outbound today..+330 days (UTC), trip ≤ 30 days (`INPUT_LIMITS` in `limits.ts`).
- Display names are copied from the caller's own `users.name` only (never email), falling back to "Traveler".
- The integration 403 tests send `{}` bodies, which the upstream rejects as invalid, so even a broken guard can't bill a search or send an email.
**Unsure about:**
- The fake tools follow my reading of `putRecord`, not the real DO; the HTTP tests cover the real path for create/join/ghosts, but not `deleteWhere` on fares with real rows.
- The last-seat race guard and the concurrent-join convergence are reasoned, not tested against the real room under concurrency.
- api tests now need pool accounts (they skip with a message if there are fewer than 2).
**I verified myself (how):**
- …

---

## Phase 3b — First screens and the two-user flow — Sat Nov 21
**Agent (Claude Code) did:**
- Rulings from 3a: `joinTrip` → `trip_locked` for newcomers to a locked trip; trip creation capped at 10/user/UTC day in `usage` (`cap_reached`, counted only on success). SPEC §6 + Changelog rows 22–24.
- New actions: `previewInvite` (what /join shows to a non-member) and the test-only `__testLockTrip` (NOTES P1, P2).
- Screens under `(app)/(protected)`: `/trips` (my trips + create form, navigates after the server confirms), `/join/:code` (preview, Join, messages for wrong code / full / locked), `/t/:tripId` with the Crew tab (member + ghost list with "airports set" / "budget set ✓" / Ghost badges; Your settings; private budget; organizer invite link + ghost add/edit/remove). Other tabs disabled. "Trips" in the nav.
- The client writes only its own `travelers` row (constraint fields) and its own `budgets` row (`tripId`, `maxUsd`; `userId` is stamped by the room), then sets `hasBudget = 1`. Write controls wait for `useMutations().ready`; every async surface has loading / empty / error-with-retry / success.
- Pure helpers with tests: `src/lib/format.ts`, `searchAirports` in `src/lib/airports.ts`.
- `tests/trips.spec.ts` (users(2), 7 tests): UI create → invite link → join → Bob's airport change live on Alice's page; budget privacy when Bob joined before and after the budget was set (his page's `useQuery('budgets')` row count, every WebSocket frame he received, and the RBAC-on agent tool route, with a control showing Alice's own probe returns her row); non-member not-found; invite page errors; live ghost add/edit/remove; `usage` unreadable and unwritable for both users.
- Results: tsc 0 errors, eslint 0 problems, unit 13 files / 202 tests, smoke+api 24, e2e 34 — all pass.
- Mutation check: budgets `read: true` + trips `read: true` → the two budget tests and the not-found test fail; restored.
- Phone-width (390px) screenshots of /trips and a trip page checked by eye; moved the create form above the list.
**What broke / surprised me:**
- My frame check flagged `maxUsd` on Bob's socket: it was the room's schema listing (column names, no values), not data. The test now skips that one message type and still checks the amount in every frame (NOTES P3).
- The agent tool route wants `{ input: {...} }`; a bare body is `invalid_tool_input` (NOTES P5).
- Local test data persists, so a real 10/day cap would break repeated e2e runs; test trips are exempt only in dev/test (NOTES P2).
**Decisions & tradeoffs (please confirm):**
- `previewInvite` and `__testLockTrip` are new and not yet in SPEC (NOTES P1, P2).
- The invite page shows "locked"/"full" before Join is pressed (from the preview); the action still refuses on its own.
- Invite link and ghost controls are organizer-only; members see the list and chips.
- Settings save on a button (not autosave). A budget is a whole number of dollars, 1–100,000.
- `/home` and the scaffold pages stay for now; the brand link still goes to `/home`.
**Unsure about:**
- I didn't test on a real phone, only a 390px viewport. Copy-to-clipboard may be blocked on some browsers; the link is selectable as a fallback.
- `memberIds` live-join (Bob's open page receiving rows once he's added) works in the e2e runs; untested under slow networks.
**I verified myself (how):**
- …

