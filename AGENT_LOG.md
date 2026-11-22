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


---

## Live check — production test seam is off — Sat Nov 21
**Agent (Claude Code) did:** ran a read-only check against https://halfway-pearl.app.space as test account Alice.
Command: `npx playwright test --config scripts/live-check/playwright.live.config.ts`
```
LIVE POST /api/actions/noSuchAction {} -> HTTP 404 {"error":"Action not found"}
LIVE POST /api/actions/__testLockTrip {} -> HTTP 200 {"success":false,"error":"Not available.","code":"not_found"}
LIVE POST /api/actions/__testLockTrip {"tripId":"0_livecheck"} -> HTTP 200 {"success":false,"error":"Not available.","code":"not_found"}
LIVE GET /api/debug/records -> HTTP 404 404 Not Found
  ✓  1 scripts\live-check\prod-flags.live.ts:18:1 › production has the test seam off (Alice) (5.2s)
  1 passed (6.1s)
```
- Line 1: Alice's token is accepted (an unknown action is 404, not 401).
- Lines 2–3: `__testLockTrip` is deployed and refuses at its first line, `ALLOW_DEBUG_ROUTES !== 'true'`.
- Line 4: `/api/debug/*` is 404, which that route returns only when `ALLOW_DEBUG_ROUTES !== 'true'`.
- The `__test-` cap exemption is `isTestTrip()`, which requires the same `ALLOW_DEBUG_ROUTES === 'true'`, so it is off in production.
- Control: the same check against a local server (flag on) FAILS (`__testLockTrip {}` → `invalid_params`), so it can tell the two apart.
**Not done, on purpose:** I did not create `__test-` trips in production to hit the cap directly. That takes up to 10 trips plus an 11th refusal, and no trip can be deleted: there's no delete action, and `trips` has `delete: false` for every role, admin included. Production writes made: none to app data. Signing Alice in creates an auth session; the sign-in page load may have registered her `users` row if she had none.
**I verified myself (how):**
- …


---

## Phase 4 — Destinations — Sat Nov 21
**Agent (Claude Code) did:**
- SPEC §13: "organizer can delete a trip" added to stretch (not built).
- Actions in `src/actions/candidates.ts`: `addCandidate` (member), `removeCandidate`, `addMidpointHubs`, `suggestCandidates` (organizer). Each loads the trip and checks membership/organizer first, validates with `validate.ts`, and uses `LIMITS`. Max 6, checked before and after writing (concurrent writers: the newer rows back out). Duplicates refused. List frozen while `searching`/`locked`. Remove also deletes that candidate's fares, votes and fareSnapshots.
- Pure `src/lib/suggest.ts`: prompt builder, response-text extraction, defensive JSON parsing (fences, prose, wrapper objects, truncated arrays), selection (known IATA only, dedupe, free slots), `why` cleaned to ≤ 140 chars, provider failures classified with the same quota detector as flights (`detectProviderQuota`, split out of `classifyIntegrationFailure`).
- `knownHomeAirports` (`src/lib/airports.ts`) re-validates client-written home airports before midpoint/AI use (NOTES G1).
- UI: Destinations tab enabled, with a live candidate list (AI / Middle / Manual badges, "why", "Added by"), add-by-search (new `AirportCombobox`, which `AirportPicker` now reuses), organizer "Suggest with AI" / "Add geographic middle" with pending and inline error-with-retry states, remove with confirm, an empty state, and a disabled "Find fares · coming next". Checked at 390px; shortened a placeholder that was cut off.
- Tests: unit 15 files / 253 (new: `suggest.test.ts` parser + prompt + classification; `candidates.test.ts` 24 action tests with the integration mocked at the boundary). e2e `tests/destinations.spec.ts` (3 two-user tests). One real-call test in `api.spec.ts`.
- Results: `test run` (smoke+api) 29 passed; `test run e2e` with the real-call test excluded by `--grep` (so it doesn't make a second paid call) 41 passed; unit 253 passed; tsc 0, eslint 0.
- Mutation checks: turning off the post-write max check and making `suggestCandidates` member-only each failed a unit test; restored.
**What broke / surprised me:**
- The first real AI call failed: Haiku 5.5 reasons by default, and `max_tokens: 600` was all used up by reasoning (NOTES Q1). The endpoint can't turn thinking off. You chose 2048; the second real call passed (974 output tokens, 542 of them reasoning, $0.00053). Two real anthropic calls were made in total this phase.
- A Python edit wrote an en dash in cp1252 into `actions.test.ts`; caught and fixed before commit (all edited files re-checked as UTF-8).
**Decisions & tradeoffs (please confirm):**
- Error codes: `candidates_full`, `duplicate`, `search_running`, `needs_airports`, `provider_unavailable`, `ai_error`.
- The AI gets one line per traveler (airports + city/country, no names), asks for (free slots + 2) ≤ 6, and only free slots are filled. City/country come from airports.json, not the model. Home airports are discouraged in the prompt but not filtered for AI (a trip to someone's home city is legitimate); midpoint does exclude them.
- An AI reply with no usable airports is still a success (`added: []`) and counts against the cap.
- Dev/test-only: `__test-` trips skip the AI cap and get `debug: { prompt, raw }` (NOTES Q3, SPEC #28).
- `removeCandidate` also deletes fareSnapshots (beyond "fares and votes"), so stale price history can't come back if the airport is re-added.
**Unsure about:**
- The post-write max check and member re-sync are tested with the fake store, not against the real room under concurrency.
- Reasoning length varies by prompt; 2048 has ~2× headroom over the one observed call. A longer trip/vibe could need more.
- I only checked layout at 390px in headless Chromium, not on a real phone.
**I verified myself (how):**
- …


---

## Phase 5 — Fare search and results — Sat Nov 21
**Agent (Claude Code) did:**
- Ruling applied: AI `max_tokens` 2048 → 3000 (`src/lib/limits.ts`, SPEC #29). Phase 4 decisions recorded as approved (SPEC #30).
- `src/server/flights-source.ts`: the fixture seam (both gates: `ALLOW_DEBUG_ROUTES === 'true'` and a `__test-` name). Fixture answers are the sample rewritten for the route and varied by a hash of "origins>destination" (price −60…+180, times +0…+120 min, price level), with a 600 ms delay so progress is visible. No real SerpApi call was made this phase.
- `src/server/fare-search.ts` (dispatched from `src/jobs.ts` with `createAppTools(env, env.OWNER_USER_ID)`): re-validated travelers × candidates, home pairs at $0 with no call, dedupe by origin set, 6h route cache in a new server-only `fareCache` collection, ≤ 30 calls per run and never past the global budget, 4 at a time, serial ledger, each fare row upserted as it arrives, throttled progress on the trip row, `ctx.signal` honoured, provider_unavailable stops the run (not counted, banner message), ranking aggregates with server-side budgets (real travelers only, positive amounts), snapshots, status → results; final-attempt failure → back to results/gathering with a generic error.
- Actions: `startSearch` (organizer; locked / running / needs airports / needs destinations / caps via `decideRunStart`, all before enqueue; counters and trip fields rolled back on `enqueue_failed`) and `toggleVote` (member, own vote only).
- UI: "Find fares" enabled (organizer; hints for why it's disabled; error-with-retry), progress bar from the trip row on Destinations and Results, Results tab enabled: Cheapest / Fairest / Together, cards with group total, each person's fare (origin, stops, times, airline, Google Flights link), price-level badge, "Everyone lands within", fits-everyone badge only when stored, the viewer's private budget line, "Missing fares for …", live vote button and tally, provider-unavailable banner, empty state. Pure view model in `src/lib/results.ts`. Checked at 390px.
- Tests: unit `fare-search.test.ts` (19: dedupe, home pairs, cache incl. changed constraints and expiry, re-validation, run cap, global cap, provider_unavailable twice, generic error, retry without duplicates, duplicate delivery, final failure, skips, cancel, fitsAll privacy guard, fixture seam both ways, mid-run join), `flights-source.test.ts`, `search.test.ts` (startSearch + toggleVote), `results.test.ts`, schema tests for `fareCache`. e2e `tests/results.spec.ts` (two users).
- Results: unit 19 files / 302 passed; `test run` (smoke+api) 31 passed, including the one real AI call at max_tokens 3000 ($0.00062); `test run e2e` with the real-call test excluded by `--grep` 44 passed; tsc 0, eslint 0. Real SerpApi calls: 0. Real Anthropic calls: 1.
- Mutation checks: removing the call cap failed 3 job tests; removing the origin-set dedupe failed 6; both restored.
**What broke / surprised me:**
- My first fixture cache keys were global, so a second e2e run the same day would have been served instantly from cache and the progress check could race; scoped fixture keys per trip.
- The first Results UI showed only a progress bar during a first search (no live fill-in); fixed after looking at the 390px screenshot.
**Decisions & tradeoffs (please confirm):**
- New `fareCache` collection (NOTES R1, SPEC #31).
- Stale-search recovery after 20 min (R2). `__test-` budget exemption in dev/test (R3). A provider outage still uses one of the trip's 2 daily searches (R4).
- Unanswered pairs (cap / outage / cancel) get `status 'error'` rows so cards say who's missing.
- "Over someone's budget" badge when `fitsAll = 0` (only possible with ≥ 3 budgets).
- Votes allowed in any status except locked; the button lives on the Results tab.
- Watch mode returns `{ skipped }` for now.
**How many real calls would a 3-traveler × 4-destination search make?** At most 12 (one per traveler × destination, $0.39). Fewer when two travelers have the identical home-airport set (one call per set and destination) or a destination is someone's home airport (no call). A repeat search within 6h makes 0. The global 80/day budget allows about six fresh searches of that size per day.
**Unsure about:**
- `flights.ts` is still unverified against a real SerpApi response (R7).
- Concurrency and retries are tested with the fake store and fake JobContext; the real JobRoom path was exercised only by the fixture-mode e2e.
- Layout checked at 390px in headless Chromium only.
**I verified myself (how):**
- …


---

## Between phases — SerpApi retry — Sat Nov 21
- Retried the one approved `serpapi/flights` call (ORD,MDW → BNA, Dec 11–13). Same provider 429 ("Your account has run out of searches."), billing released. Not retried; no fixture saved, nothing changed or committed. `flights.ts` is still unverified against a real response (NOTES R7).

## Phase 6 — Lock, book and emails — Sat Nov 21
**Agent (Claude Code) did:**
- Phase 5 rulings recorded (SPEC #36). One wording mismatch flagged, not changed: NOTES S8.
- `lockTrip` (`src/actions/lock.ts`, organizer): only from `results`, only a complete candidate (`not_ready`, `search_running`, `incomplete`, `not_found`, `trip_locked`); locks, then emails each real member (not ghosts) their own fare, origin, times and booking link. Email failure never undoes the lock; calling it again for the same destination sends only the missing emails. `setWatch` (organizer) sets `watchEnabled`.
- Pure template builder `src/lib/email.ts`: one recipient per message, "Halfway" in subject and body, no budget input at all, user text escaped and kept on one line, safe booking links only (built Google Flights URL otherwise). Sender `src/server/lock-emails.ts`: `emailLog` claim before each send (new server-only collection, NOTES S1), per-email cap check (`emailsAllowed`), serial ledger, addresses never stored/logged/returned. Email seam `src/server/email-source.ts` (NOTES S2).
- UI: Results → organizer "Lock this destination" on complete cards with a confirm dialog, Locked badge, toast with the email summary, jump to Book. Book tab enabled when locked: destination, your fare and booking link, live checklist "X of Y booked" (own row for members, ghosts via `updateGhost` for the organizer), "Email booking links again", watch switch disabled and labelled "Daily fare watch: coming next". Checked at 390px; made the disabled switch visibly dimmed.
- Tests: `src/lib/email.test.ts` (11: content, no budget even with sloppy input, no other address, escaping, home/missing fares, unsafe links, address validation), `src/actions/lock.test.ts` (15: ghosts excluded, own fare only, caps per trip and global, retry and concurrent calls don't double-send, failure keeps the lock, billing-released not counted, stale claim, seam both ways, refusals, join refused after lock, setWatch), schema test for `emailLog`. e2e `tests/book.spec.ts` (two users). api: the one real email test, plus `lockTrip`/`setWatch` 401s.
- Results: unit 21 files / 330 passed; `test run` (smoke+api) 34 passed, incl. the one real AI call ($0.00059) and the one real `email/send` call (`sent: 1`); `test run e2e` with both real-call tests excluded by `--grep` 47 passed; tsc 0, eslint 0. Real calls this phase: 1 email/send ($0.013), 1 anthropic, 0 SerpApi.
- Mutation checks: dropping the ghost/member filter failed 4 lock tests; dropping the "already sent" check failed 6; both restored.
**What broke / surprised me:**
- My e2e expected Bob to stay on Results after the lock; his page moved to Book because he hadn't picked a tab (NOTES S7). Kept the behaviour, fixed the test.
- The disabled Switch looked active: the primitive's `disabled:` styles don't match Base UI's `data-disabled`. Fixed locally on the Book tab.
- A shell heredoc for the docs failed to parse and wrote nothing; redone with the Write tool.
**Decisions & tradeoffs (please confirm):**
- `emailLog` collection and claim-before-send (S1); `__test-` email seam and the `__test-real-email-` opt-in (S2).
- Failed sends count against the caps unless billing was released (S4).
- Retry = `lockTrip` again with the same destination, exposed as "Email booking links again" (S5).
- Members who haven't picked a tab jump to Book on lock (S7).
- Kept `__testLockTrip` (used by the invite-page e2e; still double-gated).
**Unsure about:**
- Delivery of the real email: accepted by the platform, but the test address is `@deepspace.test` (S3).
- NOTES S8: your Phase 5 ruling says outages don't count toward the daily searches; the code counts them.
- Concurrency of the claim pattern is tested with the fake store, not the real room.
- Layout checked at 390px in headless Chromium only.
**I verified myself (how):**
- …

## Phase 7 — Fare watch (plus the outage refund) — Sat Nov 21
**Agent (Claude Code) did:**
- Fix first: a fare search that ends `provider_unavailable` with zero successful real calls (and no billed failed call) gives back the trip's daily full search, on the day it was counted (`countedOn` now in the job payload). Partial outages still count. Pure rule `refundsDailyCount` (src/lib/caps.ts) + 4 job tests. SPEC #42, NOTES S8 resolved, W0.
- `fare-search` mode `watch` (src/server/fare-search.ts): shortlist = locked destination, else top 3 by votes (ties → cheaper complete total), < 6h cache reused, aggregates + one `fareSnapshots` row per re-checked destination. Never touches `status` or the full search's fields; unanswered pairs keep their previous fare and that destination gets no snapshot (W1).
- Alerts (src/lib/watch.ts decisions, src/server/watch-alerts.ts sender): group drop ≥ max($50, 5%) vs the previous snapshot → one email per real member with group totals and their own fare (no budget input at all); private email to one traveler the first time their fare crosses to ≤ their budget (never states the amount). Both deduped in `emailLog` (per run / once ever), within email caps, mocked for `__test-` trips. Lock emails moved onto the same `deliverOnce` helper (src/server/email-delivery.ts).
- `checkFaresNow` (organizer): refused while searching / before results / ≤ 1 day before departure / while a check is queued; 3 per trip per day (shared with the cron) + global budget; `watchQueuedAt` set before enqueue, rolled back on enqueue failure.
- Cron `fare-watch` at `0 8 * * *` America/Chicago (src/cron.ts → src/server/fare-watch-cron.ts): watch on, results or locked, outbound > 1 day away, soonest first, max 10 per run, once-per-trip-per-day marker, caps, pending check, rollback.
- Book tab: real "Daily fare watch" switch, "Check fares now" with pending / disabled-with-reason / error-with-retry, "Last checked …", job error line, and a small sparkline of the group total (locked destination, or top of the shortlist). Book now opens at status results (W8). Checked at 390px for organizer and member.
- New trips columns `watchQueuedAt`, `watchError`; new codes `watch_running`, `watch_ended`; `timeAgo` helper.
- Tests: unit `fare-watch.test.ts` (13: shortlist-only calls, cache, locked trip, skips, drop email + no budget + own fare, retry/duplicate/no-new-drop, under threshold, email cap, mocked seam, first crossing only, already under budget, total and partial outage), `fare-watch-cron.test.ts` (7), `checkFaresNow` (8 in search.test.ts), watch.ts (shortlist, window, Chicago date, pending, cron filter), caps (refund rule), email templates, format. e2e `tests/watch.spec.ts` (two users: check now → snapshot → both sparklines gain a point live; 4th check refused; toggle seen live; lock switches the watched destination). `book.spec.ts` updated for the now-live switch and the Book tab opening at results. api: `checkFaresNow` 401.
- Results: unit 23 files / 385 passed; `test run` (smoke+api) 35 passed, incl. the one real AI call and the one real `email/send` call (`sent: 1`, now through `deliverOnce`); `test run e2e --grep "^(?!.*one real).*$"` (both real-call tests excluded) 49 passed; tsc 0; eslint 0. Real calls this phase: 1 email/send, 1 anthropic, **0 SerpApi**.
- Mutation checks: refunding partial outages failed 3 tests; keying the private email per send (not first-time-only) failed 2; both restored.
**What broke / surprised me:**
- My price-shifting test helper crashed on the fixture's deliberately malformed (null) entries, so every call "errored"; fixed in the helper, not the code.
- Alice legitimately crossed under budget for 2 shortlisted destinations, not 1; the test now computes the expected crossings from her fares.
- Bash heredocs with backticks and quotes failed to parse again; used files written with the Write tool.
- A throwaway screenshot spec (deleted) miscounted the cap on its first try.
**Decisions & tradeoffs (please confirm):**
- W0 refund also applies to watch checks; an outage after a billed error isn't refunded.
- W1 keep previous fares on unanswered pairs in watch mode (no snapshot for that destination).
- W4 drop emails keyed per run, not per day; W5 private email once ever per destination, amount never stated.
- W7 Chicago calendar for "≤ 1 day"; "stops automatically" is enforced, `watchEnabled` isn't flipped; >10 watched trips → later ones skipped that day.
- W8 Book tab enabled at results.
**Unsure about:**
- The cron hasn't run on a deployed app (not deployed per your instruction); unit-tested, and the job path is exercised by `checkFaresNow` in e2e.
- Drop/crossing emails are verified with the fake store and the mocked seam only; no real watch email was sent.
- Missed crossing on a crash-then-retry (W5) is accepted, not fixed.
- `flights.ts` still unverified against a real SerpApi response (R7).
**I verified myself (how):**
- …

## Phase 8 — Polish and README — Sun Nov 22
Rulings recorded: Phase 7 W0–W9 approved (SPEC #48). No business logic, schemas, permissions, caps or jobs changed.
**Agent (Claude Code) did:**
- Read the DeepSpace design pages (overview, direction, style tile, patterns, anti-AI gate, product polish, worked examples) and wrote the Design Direction block at the top of `src/pages/index.tsx`.
- Theme `halfway` (`src/themes.css`, light): warm paper, navy ink, one vermilion accent. Every text pair checked ≥ 4.5:1; status colors darkened because white on the scaffold's green/amber was ~2.5:1. Fonts: Fraunces (headings), Inter (body), IBM Plex Mono (codes/fares) from Google Fonts. Scaffold slate/paper themes removed.
- Landing (static, no data hooks, prerendered): 5-word headline, a route map where three dashed routes draw once and meet at a pin (CSS keyframes, off under reduced motion), a 3-step "how it works" on an itinerary line, the three differentiators as alternating rows with small code-drawn visuals, a contrast CTA band with the solo hint, and a mono footer. Design gate: no hex/rgb/named colors, no foreground opacity, no emoji, no loops, no placeholder copy.
- Nav: Halfway wordmark + "Trips" (highlighted on trip and invite pages too) + sign in/out; the mobile menu went away with only one link. Deleted `settings.tsx` and `api-status.tsx`; `/home` now forwards to `/trips` (the sign-in callback still lands on `/home`, so the route stays).
- `/trips` empty state with a "Try it solo" hint (create a trip, press Add traveler twice for ghosts).
- Trip page "next step" guide: pure `src/lib/next-step.ts` (11 unit tests) + `NextStepGuide.tsx` (six-stop progress line, one card, a button that switches tab). Renders nothing while its queries load or fail; the tabs already show those states.
- Provider outage: shared `ProviderOutage` banner keeps the stored sentence and adds what it means in plain words and that the rest of the trip still works; also used when a watch run's `watchError` is the outage.
- Titles on every page ("Your trips · Halfway", the trip's name, "Join a trip · Halfway", "Sign in · Halfway", "Page not found · Halfway"); the layout-wide slug title is gone. SVG + matching 32px ICO favicon. Friendly static 404.
- Accessibility: visible focus outline scoped to links/buttons/tabs/switches/comboboxes; raw `<select>`s in the constraint fields replaced with the kit's `Select` (labelled; found by its label in Playwright); `aria-label` on the nav and tab list. Tabs keep Base UI's arrow-key handling.
- Phone pass at 390px (headless Chromium, throwaway spec, deleted): landing, 404, signed-out, trips, new trip, crew, destinations, searching, results, book before/after lock, join, ghost dialog with an open select. Fixed from the screenshots: a fare tag sitting on the SEA dot; "Trips" not highlighted on trip pages.
- Tests: `smoke.spec.ts` rewritten for the real landing, nav, `/home` redirect, signed-out title, 404, favicon. `api.spec.ts` and `collab.spec.ts` use `/trips` instead of `/home`. The two scaffold API-status tests were replaced by an e2e that fails the invite lookup at the network, retries, and proves the page didn't reload. New `tests/guide.spec.ts` walks the solo path (organizer + 2 ghosts) through all six guide stages.
- README.md: what/why (MeetPoint, Kayak Rendezvous, the coordination gap), features, usage, architecture (rooms, collections and readers, actions, job, cron, integrations), integrations used and left out, privacy model, spend caps with costs, test suites, run/deploy, known limitations, what's next.
- Results: unit 24 files / 396 passed; `test run` (smoke+api) 39 passed, incl. the one real AI call and the one real `email/send` (`sent: 1`); `test run e2e --grep "^(?!.*one real).*$"` 53 passed (second run; see below); tsc 0; eslint 0; `vite build` prerenders `/` with the real title. Real calls this phase: 1 anthropic, 1 email/send, 0 SerpApi (plus the screenshot runs, which used fixtures and mocked emails only).
**What broke / surprised me:**
- First e2e run: 52 passed, 1 failed. The landing's title test waited the default 5s for the page while ~50 tests ran in parallel against the dev server; it passed alone and in the smoke run. Gave the landing checks the same 15s the other app-shell waits use; the re-run passed 53/53. I didn't re-run smoke+api after that timeout-only change, to avoid another round of real calls.
- Full-page screenshots clip because the app scrolls inside `main`; re-shot with a tall viewport.
- A join screenshot came out blank: the cold auth check hadn't finished after 1.5s. Waiting for the heading showed the page fine.
**Decisions & tradeoffs (please confirm):**
- `/home` kept as a redirect instead of changing the sign-in callback in `http-routes.ts` (avoids touching server code this phase).
- Google Fonts adds a third-party request from visitors' browsers (noted in the README). Self-hosting would mean new font packages.
- The guide's "Bring in the group" step uses the same "2 travelers with airports" threshold as `startSearch`.
- `BRAND`/`pageTitle` live in `src/brand.ts` (no SDK import) so the static landing and 404 stay off the SDK chunk; `APP_NAME` is still the slug.
**Unsure about:**
- The `/trips` empty state wasn't screenshotted: both pool accounts already have trips. It's simple markup, but unseen.
- The outage banner wasn't seen in a browser (the fixture seam can't produce a provider outage); its condition is the same string match as before.
- Contrast was computed for the theme tokens, not audited per screen; the old `Switch` disabled-style issue from Phase 6 is still handled locally.
- 390px checked in headless Chromium only.
**I verified myself (how):**
- …
