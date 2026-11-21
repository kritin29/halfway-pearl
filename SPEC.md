# Halfway — product & technical spec

> Working name: **Halfway**. Pick your own app slug (e.g. `halfway-<yourname>`); it becomes `<slug>.app.space`.
> This spec is the single source of truth for Claude Code. If DeepSpace docs or installed types contradict it, the docs/types win — note the conflict in `NOTES.md` and update this file.

---

## 1. One-line pitch

Friends in different cities find the best place to meet — with **private budgets**, everyone entering their own constraints, fares checked in parallel, **"is this a good price?"** badges, **arrival alignment**, and a **daily group fare watch** that emails you when the trip gets cheaper.

## 2. Why it exists (competitors acknowledged)

MeetPoint, Kayak Rendezvous, Betweengs and Midway already do multi-origin "cheapest city" search. They are **single-player calculators**: one person types everyone's cities, runs one search, and that's it.

Group trips don't fail on search. They fail on coordination:
- nobody wants to say "I can only afford $300" in the group chat → **private budgets**
- one person has to collect everyone's airports/dates/dealbreakers → **everyone enters their own**
- prices move after the first search → **daily fare watch + alerts**
- people land at 9am and 11pm → **arrival-spread ranking**
- half the group never books → **lock + booking checklist + reminders**

Halfway is the coordination layer; flight search is one component.

## 3. Users & core flow (the important path)

1. **Organizer** signs in, creates a trip: name, outbound date, return date, optional vibe ("beach, cheap, not Florida").
2. Organizer shares the invite link. Friends sign in and **join**.
   - Organizer can also add **ghost travelers** (name + home airport) for people who won't use the app. Ghosts have no private budget. *(This also lets a single reviewer demo the app alone.)*
3. Each traveler, on their own device, sets **public constraints** (home airports, max stops, no red-eyes, earliest departure hour) and an optional **private budget** (max round-trip fare). The crew list shows "budget set ✓" — never the amount.
4. Destinations: organizer (or any member) adds candidates by:
   - **AI suggestions** from the vibe + origins (validated against the airport list),
   - **Geographic middle** hubs (deterministic: nearest major airports to the travelers' centroid),
   - manual search-and-add.
   Max 6 candidates.
5. Organizer clicks **Find fares** → background job searches each traveler × candidate in parallel, results stream in live on every member's screen (fare rows appear as they arrive; progress comes from `searchProgress`/`searchMessage` on the trip row, not from `useJobs`).
6. **Results**: ranked cards with tabs **Cheapest / Fairest / Together**. Each card: group total, per-person fare, price-level badge ("low / typical / high" vs Google's typical range), stops, arrival-spread ("everyone lands within 1h 40m"), and **"Fits everyone's budget"** badge (see privacy rule §7). Each user also privately sees "your fare vs your budget".
7. Members **vote** (approval voting: approve any number of destinations). Live tally.
8. Organizer **locks** a destination → every member gets an email with their own Google Flights link; the Book tab shows a live checklist "Booked ✓ / Not yet". Members mark themselves booked.
9. **Fare watch** (on by default once results exist): daily cron re-checks the shortlist (top 3 by votes, or the locked destination) and emails:
   - the group when the group total drops ≥ max($50, 5%),
   - an individual (privately) when their own fare first drops under their private budget.
   A **"Check fares now"** button (organizer) runs the same job on demand — used for demos and tests.

## 4. DeepSpace building blocks used (and why)

| Need | Primitive | Why this one |
|---|---|---|
| Sign-in, identity | DeepSpace auth (`useAuth`, verified JWT) | Platform-provided; never reimplement |
| Shared live trip state | **RecordRoom** collections + `useQuery`/`useMutations` | Every member sees updates instantly |
| Private budgets | Collection with `read: 'own'` | Enforced in the Durable Object before broadcast, not client-side |
| Trip-scoped visibility | `collaboratorsField: 'memberIds'` + `read: 'collaborator'` | Rows visible only to trip members |
| Trusted writes (join, lock, votes, search) | **Server actions** (`src/actions/index.ts`) | RBAC-off tools, so every action checks membership itself |
| Parallel fare search | **JobRoom** job (`src/jobs.ts`) | Outlives the request, retries. Room is **admin-only** for read and write (clients never use `useJobs`); the job copies progress onto the trip row |
| Daily fare watch | **CronRoom** task (`src/cron.ts`) | Durable schedule with history/logs. Cron writes (trigger/pause/resume) are admin-only |
| Flights | `serpapi/flights` integration | Google Flights data + `price_insights`, no API key |
| Destination ideas | `anthropic/chat-completion` integration | Turns a vibe into candidates; output is validated. Always pass a Haiku model (`claude-haiku-5-5`) and `max_tokens` ≈ 600 — the endpoint defaults to Opus/4096 |
| Alerts & booking links | `email/send` integration | The platform ignores `from`; mail comes from `DeepSpace Apps <notifications@updates.app.space>`. Brand via subject/body ("Halfway"); $0.013/email, capped |
| Server tools for actions, jobs, cron | `createAppTools(env, actingUserId, callerJwt?)` in `src/server/app-tools.ts` | One RBAC-off tools factory (get/query/create-with-recordId/update/remove/deleteWhere/integration) instead of `buildCronContext`, which lacks get/orderBy/upsert and defaults to room `"default"` |

**Deliberately not used** (say this in the writeup): weather (forecasts only cover a few days; trips are weeks out → misleading), hotels (stretch goal only), maps integration (optional MapLibre client-side visual, no integration needed), voice/LiveKit/canvas/payments (no user value here).

## 5. Data model (collections)

Rule of thumb: **any row that carries `memberIds` is written only by server actions or jobs.** Clients write only their own constraint row and their own budget row.

All trip-scoped collections include `tripId` (text) and `memberIds` (text, `{kind:'json'}` array of user ids, `collaboratorsField`). Ghost travelers have ids like `ghost:<uuid>` and are never in `memberIds`.

**Roles.** The app owner is always `admin` (pinned at connect time), and a role missing from a permissions block falls back to `'*'` and then to all-false. So **every trip-scoped collection gives `admin` exactly the `member` rules** (written out below as "admin: same as member"). Server code never needs admin; it bypasses RBAC.

**`userBound` rule.** On create, the SDK stamps a `userBound` column with the *acting* user id, even for RBAC-off server writes. Use `userBound` only where the caller is always the row's subject (`trips.organizerId`, `votes.userId`, `budgets.userId`). The job and cron act as the app owner, so they **never create rows in a collection with a `userBound` column** (trips, travelers, budgets, votes).

**Column types.** Dates: `storage:'text', {kind:'date'}` (ISO `YYYY-MM-DD`). Datetimes: text ISO. JSON arrays: `{kind:'json'}`. 0/1 flags: `storage:'number'`.

**Known limitation (createdBy).** `'collaborator'` read = owner OR in `memberIds`, and on collections without `ownerField` (candidates, fares, fareSnapshots) the owner is `createdBy`: the member whose action created the row, or the app owner for rows the job created. A creator would keep read access to that row after leaving a trip. We are not building leave-trip, so this is accepted. (If it is ever built, set `ownerField: 'tripId'` on those collections so only `memberIds` counts.)

### `trips`
| column | type | notes |
|---|---|---|
| name | text | max 80 |
| organizerId | text | `ownerField`, `userBound` |
| memberIds | text (json) | `collaboratorsField`; includes organizer |
| inviteCode | text | random 10+ chars, unique |
| status | select: gathering, searching, results, locked | |
| outboundDate | date | YYYY-MM-DD |
| returnDate | date | YYYY-MM-DD, > outboundDate |
| vibe | text | max 200 |
| lockedIata | text | nullable |
| watchEnabled | number (0/1) | default 1 |
| lastSearchAt | datetime | |
| searchJobId | text | nullable; set by `startSearch`/`checkFaresNow` |
| searchProgress | number | 0..1, written (throttled) by the job |
| searchMessage | text | e.g. "Checked ORD→BNA"; never contains budgets |
| searchError | text | nullable; set when the job fails for good |

`uniqueOn: ['inviteCode']`. Permissions: `member: { read: 'collaborator', create: false, update: false, delete: false }`, admin: same as member. (All writes via actions.)

### `travelers` (public per-person constraints)
| column | type | notes |
|---|---|---|
| tripId, memberIds | | |
| userId | text | `ownerField`, `immutable`, `required`. **Not `userBound`** (it would overwrite ghost ids with the organizer's id). Set explicitly by actions: caller id for real users, `ghost:<uuid>` for ghosts |
| isGhost | number 0/1 | |
| displayName | text | |
| homeAirports | text (json array of IATA) | 1–3 codes, validated |
| maxStops | number | 0, 1, 2 (2 = any) |
| noRedeye | number 0/1 | |
| earliestDepartHour | number | 0–23, default 0 |
| hasBudget | number 0/1 | set by the client when it saves a budget |
| booked | number 0/1 | |

`uniqueOn: ['tripId','userId']` (keeps `joinTrip` idempotent). Permissions: `member: { read: 'collaborator', create: false, update: 'own', delete: false, writableFields: ['homeAirports','maxStops','noRedeye','earliestDepartHour','hasBudget','booked'] }`, admin: same as member.
Security without `userBound`: no client role can create traveler rows, and `userId` is not in `writableFields`. Schema-lint stays quiet because no non-admin role has `create: true`.
Ghost rows: created/edited only via organizer actions (`update: 'own'` never matches a `ghost:` id).
`hasBudget` is client-set, so it only drives the "budget set ✓" chip. The ≥3-budgets privacy rule (§7) counts actual `budgets` rows server-side.

### `budgets` (PRIVATE)
| column | type | notes |
|---|---|---|
| tripId | text | |
| userId | text | `ownerField`, `userBound` |
| maxUsd | number | > 0 |

`uniqueOn: ['tripId','userId']`. Permissions: `member: { read: 'own', create: true, update: 'own', delete: 'own' }`, admin: same as member (so even the app owner sees only their own budget). No `memberIds` column. **Only the owner and server code can read it.** A user can create a budget row for any `tripId` (harmless: only they see it); server code reads budgets with `where: { tripId }` and ignores userIds that aren't travelers on the trip.

### `candidates`
tripId, memberIds, iata, city, country, why (text), source (select: ai, midpoint, manual), addedBy, plus aggregates written by the search job: `complete` (0/1), `groupTotal`, `maxFare`, `minFare`, `arrivalSpreadMin`, `fitsAll` (0/1/null — see §7), `missingFor` (json array of displayNames), `lastCheckedAt`.
Permissions: read `'collaborator'`, writes server-only; admin: same as member.

### `fares`
tripId, memberIds, candidateIata, travelerId (userId or ghost id), originIata (the airport actually used), price, priceLevel (low/typical/high/unknown), typicalLow, typicalHigh, stops, durationMin, departLocal, arriveLocal (outbound leg, ISO-ish local time strings), airline, bookingUrl, status (select: ok, no_results, filtered_out, error), fetchedAt.
Permissions: read `'collaborator'`, writes server-only; admin: same as member.

### `votes`
tripId, memberIds, userId (`ownerField`, `userBound`, `immutable`), candidateIata. `uniqueOn: ['tripId','userId','candidateIata']`. Read `'collaborator'`; writes via `toggleVote` action (caller is the subject, so `userBound` is correct here); admin: same as member.

### `fareSnapshots`
tripId, memberIds, candidateIata, groupTotal, maxFare, checkedAt. Read `'collaborator'`; server-only writes; admin: same as member. Drives the "price over time" sparkline and drop detection.

### `usage` (server-only spend ledger)
day (YYYY-MM-DD), key (e.g. `serpapi:global`, `serpapi:trip:<id>`, `ai:user:<id>`, `email:trip:<id>`, `email:global`), count. `uniqueOn: ['day','key']`; written with `recordId = \`${day}|${key}\`` via `tools.create(…, recordId)` (upsert). Permissions: `'*'`, `viewer`, `member` **and `admin`** all `{ read: false, create: false, update: false, delete: false }` — unlisted roles fall back to `'*'`, and server tools bypass RBAC (`X-App-Action`). **Tested** three ways (NOTES §3): unit test with the SDK's `canRead/canCreate/canUpdate/canDelete`; two-user e2e probe through the RBAC-on agent tool route expecting zero rows and a refused create; and a cap test proving the server reads/writes it.

### `users` (scaffold, required)
Keep `USERS_COLUMNS` and `read: 'own'`. Add `roster: 'read-policy'` so `useUsers()` doesn't list every registered user's name to everyone. Show names from `travelers.displayName` (copied from the caller's `users.name` by `createTrip`/`joinTrip`).

## 6. Server actions (`src/actions/index.ts`)

Every action: (1) load the trip with `tools.get`, (2) check the caller is in `memberIds` (or is `organizerId` where noted), (3) validate params, (4) write. Never trust ids from params without loading and checking. Return `{ success, data }` / `{ success: false, error, code }`. Actions get their tools from `createAppTools(env, userId, callerJwt)` (`src/server/app-tools.ts`).

| action | who | does |
|---|---|---|
| `createTrip({name, outboundDate, returnDate, vibe})` | any signed-in | creates trip (memberIds=[caller]), inviteCode, caller's traveler row |
| `joinTrip({inviteCode})` | any signed-in | adds caller to trip.memberIds, creates traveler row, **propagates new memberIds to every trip-scoped row** (travelers, candidates, fares, votes, fareSnapshots). Idempotent. Max 8 travelers incl. ghosts |
| `addGhost({tripId, displayName, homeAirports, ...})` / `updateGhost` / `removeGhost` | organizer | ghost traveler rows |
| `addCandidate({tripId, iata})` | member | validates IATA against `src/data/airports.json`; max 6 |
| `suggestCandidates({tripId})` | organizer | AI (`claude-haiku-5-5`, `max_tokens` ≈ 600, JSON-only system prompt) → JSON → validate each IATA → insert up to (6 − existing). Cap: 5 AI calls per user per day (`usage`) |
| `addMidpointHubs({tripId})` | organizer | deterministic: centroid of travelers' home airports (lat/lon) → nearest 2 "major" airports not already candidates |
| `removeCandidate({tripId, iata})` | organizer | also deletes its fares/votes |
| `startSearch({tripId})` | organizer | refuses if status=searching; checks caps, increments counters, sets status=searching, `enqueueJob(env.JOB_ROOMS, \`app:${env.DEEPSPACE_APP_ID}\`, 'fare-search', {tripId, mode:'full'}, {maxAttempts: 2, enqueuedBy: userId})`, stores `searchJobId`, clears `searchError`. `enqueueJob` throws on failure → roll status back, return `code: 'enqueue_failed'` |
| `toggleVote({tripId, iata})` | member | upsert/delete own vote |
| `lockTrip({tripId, iata})` | organizer | status=locked, lockedIata; emails each real member their booking link (within email caps) |
| `setWatch({tripId, enabled})` | organizer | |
| `checkFaresNow({tripId})` | organizer | enqueues `fare-search` with `mode:'watch'` (same caps) |

## 7. Ranking & privacy rules (`src/lib/ranking.ts` — pure, unit-tested)

For each candidate, using the chosen fare per traveler:
- **complete** = every traveler has a fare with status `ok`. Incomplete candidates sort last with "missing fares for …".
- **groupTotal** = Σ price. **maxFare** = max price. **minFare** = min price.
- **arrivalSpreadMin** = max(arriveLocal) − min(arriveLocal) in minutes (same destination ⇒ same timezone, so local times compare directly).
- **fitsAll** = every traveler *who has a budget* has price ≤ budget.
  **Privacy guard:** store `fitsAll = null` (hidden) unless **at least 3 travelers have budgets**. With 2, a "doesn't fit" badge would reveal an upper bound on the other person's budget. With ≥3 nobody can tell who is the constraint. Each user still sees their *own* fit privately (computed client-side from their own budget row + their own fare).
- Sort tabs:
  - **Cheapest**: groupTotal ↑
  - **Fairest**: maxFare ↑, tie → groupTotal ↑ (protects the worst-off person)
  - **Together**: arrivalSpreadMin ↑, tie → groupTotal ↑
- Badges: "Fits everyone's budget" (fitsAll=1), price level from `price_insights.price_level`, "Everyone lands within Xh Ym" when spread ≤ 180.

### Fare selection per traveler × candidate (`src/lib/flights.ts` — pure, unit-tested against a saved fixture)
The real fixture was to come from exactly **one** real call in Phase 2 with this body:
`{"departure_id":"ORD,MDW","arrival_id":"BNA","outbound_date":"2026-12-11","return_date":"2026-12-13","type":"1","adults":1,"currency":"USD","hl":"en"}`
That call failed upstream (`SerpAPI error 429: "Your account has run out of searches."`, billing released). Until the quota is back, `flights.ts` is written against SerpApi's published format (https://serpapi.com/google-flights-api, "JSON structure overview") and tested with the **hand-made** `src/lib/__fixtures__/serpapi-flights-sample.json` (top-level `_note` says so). **Re-run the same single call and cross-check field names before Phase 5 ships.**
0. **Home pair:** if the candidate is one of the traveler's home airports, the fare is `price 0`, `status 'ok'`, `stops 0`, `originIata = candidate`, no times, and **no API call** is made for that pair (`homeFare()`). Ranking counts it in totals but not in the arrival spread.
1. Call `serpapi/flights` with `departure_id` = traveler's home airports comma-joined (e.g. `ORD,MDW`), `arrival_id` = candidate IATA, `outbound_date`, `return_date`, `type: '1'` (round trip; SerpApi uses 1 = round trip, 2 = one way), `adults: 1`, `currency: 'USD'`, `hl: 'en'`. Cost: **$0.0325 per call** (from `integrations info`, Nov 20).
2. Merge `best_flights` + `other_flights`. Apply constraints: stops ≤ maxStops (layovers count), drop red-eyes if `noRedeye` (outbound departs 21:00–04:59 local or arrives next day), drop departures before `earliestDepartHour`.
3. Pick the cheapest remaining → fare row. If none remain but results existed → `filtered_out`; if no results → `no_results`.
4. Copy `price_insights.price_level` and `typical_price_range` when present.
5. `bookingUrl`: use `search_metadata.google_flights_url` only when it is a google.com `/travel/flights` URL that carries a search (`tfs`/`q`); the docs' example value is a generic `…/travel/flights?hl=en`. Otherwise build `https://www.google.com/travel/flights?q=Flights to <DEST> from <ORIGINS> on <OUT> through <RET>&curr=USD&hl=en`.
6. Parse defensively: a malformed itinerary (no positive numeric `price`, no legs, unparseable times, non-object) is skipped, never a crash. Accept the raw SerpApi JSON or the same wrapped in `{ data }`. Only outbound legs are in the response (returns need a `departure_token` request), so times/red-eye/arrival spread are outbound-only; `price` is the round-trip price.

**Verify field names against a real response** when the quota is back — the hand-made fixture follows the docs, not observed output.

### Integration failures (`classifyIntegrationFailure` in `src/lib/flights.ts`)
- **`provider_unavailable`**: SerpApi out of quota / rate-limited (HTTP 429 or "run out of searches"). The platform releases billing for these. The job **does not retry** (it returns instead of throwing, so JobRoom's `maxAttempts` doesn't re-run it), makes **no further calls** in that run, does **not** increment `usage` for the failed call, and writes the human message "Live flight prices are temporarily unavailable from our data provider. This did not count against your daily search limit. Please try again later." to `trips.searchError`. Status moves back from `searching` (to `results` if earlier results exist, else `gathering`).
- **`error`**: everything else. That pair's fare row gets `status 'error'`; the run continues; the call counts against `usage` (we can't know it wasn't billed). The user sees a generic message, never provider text.
- Unit-tested with the real 429 envelope saved (verbatim, nothing secret in it) at `src/lib/__fixtures__/serpapi-error-429.json`.

## 8. Background job: `fare-search` (`src/jobs.ts`)

Payload `{ tripId, mode: 'full' | 'watch' }`.
1. Load trip, travelers, candidates (`mode:'watch'` → only top 3 by votes, or the locked one).
2. Build pairs (traveler × candidate). Home pairs (candidate is a home airport) get `homeFare()` with no call. Dedupe identical (origin set, destination, dates) — two friends from Chicago share one call.
3. **Spend caps before any call** (at $0.0325/call): ≤ 30 calls per run (≤ $0.98), ≤ 2 full searches per trip per day, ≤ 3 trips started searching per user per day, global ≤ 80 serpapi calls per day (≤ $2.60/day, ≤ ~$13 over the review window). Put these numbers in one constants file so they're easy to tune. Increment `usage` per call.
4. Cache: reuse a fare fetched < 6h ago for the same key (full mode only).
5. Run calls with small concurrency (e.g. 4 at a time), write each fare row as it arrives (live fill-in), `ctx.progress(done/total, 'Checked ORD→BNA')` **and** a throttled `tools.update('trips', tripId, { searchProgress, searchMessage })` so members see progress, honor `ctx.signal`. `usage` increments go through one serial promise chain (get-then-update isn't atomic; caps are soft by ±1).
6. Compute aggregates with `ranking.ts` (needs budgets — server-side read) and update candidates; write a `fareSnapshots` row per candidate.
7. `mode:'watch'`: compare with the previous snapshot → group drop email; per-traveler private "now under your budget" email (only when crossing the threshold, not every day). Emails are deduped by markers so a retry doesn't resend, and stay within email caps.
8. Set trip status=results (unless locked), lastSearchAt, searchProgress=1.
9. Failure: a retry re-runs the whole handler (keep it idempotent; the < 6h cache makes it cheap). On the final failed attempt (`job.attempts >= job.maxAttempts`), set `searchError` and move status back from `searching`. A `provider_unavailable` failure (§7 "Integration failures") is not a thrown failure: no retry, no usage increment for that call.

**How a job reaches integrations/records (resolved, NOTES §2):** `const tools = createAppTools(env, env.OWNER_USER_ID)`. Records go to RecordRoom `app:${env.DEEPSPACE_APP_ID}` with `X-App-Action: true` (RBAC off); `tools.integration(...)` signs developer-billed calls with `APP_OWNER_JWT` and returns the `{success, data | error, code}` envelope. Jobs run as the app owner and bill the owner. User-billed integrations can't work from a job (no caller JWT).

**Fixture seam (`src/server/flights-source.ts`, NOTES C12):** Playwright's `page.route` can't intercept worker-side calls, so the job calls `searchFlights(tools, env, params, tripName)`. It returns the saved SerpApi fixture **only when** `env.ALLOW_DEBUG_ROUTES === 'true'` (set only by `deepspace dev start` / `test run`, never in production) **and** the trip name starts with `__test-`; otherwise it makes the real `tools.integration('serpapi/flights', …)` call. A unit test proves the real path is taken when the flag isn't `'true'`.

**JobRoom (NOTES C3):** `AppJobRoom` sets `authorizeWrite` and `authorizeRead` to admin-only. The default (any member) would let members enqueue `fare-search` around the caps and see every trip's job payloads/progress. The internal `/enqueue` path used by `enqueueJob` doesn't run `authorizeWrite`, so actions and cron still enqueue. One queue for the app runs jobs one at a time.

## 9. Cron: `fare-watch` (`src/cron.ts`)

`{ name: 'fare-watch', schedule: '0 8 * * *', timezone: 'America/Chicago' }` → query trips with `where: { watchEnabled: 1 }` (equality only), then filter status in (results, locked) and outboundDate > today + 1 in code → enqueue `fare-search` `{mode:'watch'}` for each (max 10 trips per run, at most once per trip per day via a `usage` marker). Uses `createAppTools(env, env.OWNER_USER_ID)`.
Arming: the scaffold's `armCronRoom` middleware and deploy's own wake-up request arm the alarm automatically. Proof of execution is `deepspace logs --search cron` → `[cron] fare-watch ok`.
**Room lockdown (NOTES C7):** `/ws/cron/:roomId` and `/ws/jobs/:roomId` return 404 unless `roomId === \`app:${env.DEEPSPACE_APP_ID}\``, because any other id would spin up an extra CronRoom with its own fare-watch schedule. The cron route's role resolver returns `admin` only for admins and `viewer` for everyone else, so members can't trigger owner-billed tasks.

## 10. Screens (mobile-first)

- `/` landing (static; no data hooks): pitch, "Start a trip", 3-step explainer.
- `/trips` (protected): my trips + create form.
- `/join/:code` (protected): join confirmation.
- `/t/:tripId` (protected) — tabs:
  - **Crew**: members & ghosts, each with airports and chips "constraints ✓", "budget set ✓". "Your settings" panel: airports, stops, red-eye, earliest hour, and **"Your private budget 🔒 Only you can see this."** Invite link copy button.
  - **Destinations**: candidate list, "Suggest with AI", "Add geographic middle", search-add input, "Find fares" button with live job progress.
  - **Results**: sort tabs, cards (see §3.6), per-person fare breakdown, your private fit line, vote button + tally.
  - **Book**: locked destination, your booking link, group checklist, fare history sparkline, watch toggle, "Check fares now".
- Every async surface has loading, empty, error-with-retry, and success states.

## 11. Integration billing config (`src/integrations.ts`)

`serpapi`, `anthropic`, `email` → `{ billing: 'developer', serverOnly: true }` with **sign-in required** (do not set `anonymous: true`). Paid calls only from server actions/jobs, never directly from the client.
**Enforced, not just a convention (NOTES C4):** the scaffold's browser proxy `/api/integrations/:name/:endpoint` would otherwise let any signed-in user call these with the owner's JWT, bypassing the `usage` caps (and turning `email/send` into an owner-billed spam relay). The proxy returns **403** for any integration marked `serverOnly`; server code still reaches them through `tools.integration`. API tests prove a signed-in browser POST to `/api/integrations/serpapi/flights` and `/api/integrations/email/send` gets 403.

**Caps live in `src/lib/limits.ts`:** SerpApi caps from §8, AI caps from §6, and email caps ($0.013/email): ≤ 20 emails per trip per day, ≤ 100 emails per day globally (starting values; tune there).

## 12. Acceptance criteria (what "done" means)

- [ ] Two real accounts can create/join a trip and see each other's constraint updates live.
- [ ] Account B cannot read account A's budget via `useQuery('budgets')` or any action (automated two-user test).
- [ ] A non-member cannot see a trip (automated test).
- [ ] Find fares fills results live; ranking tabs reorder correctly (unit-tested).
- [ ] fitsAll hidden with < 3 budgets; shown with ≥ 3 (unit-tested).
- [ ] Caps prevent > 30 calls per run and > 2 full searches per trip per day (unit-tested cap logic).
- [ ] Lock sends booking emails; Book tab checklist updates live.
- [ ] "Check fares now" writes a snapshot and sends a drop email when the total falls (drop logic unit-tested).
- [ ] A signed-in browser POST to `/api/integrations/serpapi/flights` or `/api/integrations/email/send` gets 403 (api test).
- [ ] A client cannot read or write `usage` (unit + two-user test).
- [ ] Deployed at `<slug>.app.space`; works on a phone.

## 13. Stretch (only after acceptance criteria pass)

Hotels total (`serpapi/hotels`), flexible dates (±1 day), MapLibre map of origins/candidates, "nudge unbooked" reminders, leave trip.

---

## Changelog

### 2026-11-20 — Phase 1 decisions (from NOTES.md, approved by the developer)
| # | Change | Where in this spec | From |
|---|---|---|---|
| 1 | `admin` gets the `member` rules on every trip-scoped collection (owner is always admin; missing roles fall back to `'*'` → all-false). `trips` no longer has `admin: all true` | §5 Roles, each collection | NOTES C2 |
| 2 | `usage` is all-false for `'*'`, `viewer`, `member` and `admin`; `uniqueOn ['day','key']`, deterministic recordId; test plan written down | §5 `usage`, §12 | NOTES C2, §3 |
| 3 | `travelers.userId` is no longer `userBound`; it is `ownerField` + `immutable` + `required`, with `uniqueOn ['tripId','userId']`. General `userBound` rule added (job/cron never create rows in userBound collections) | §5 Roles, `travelers` | NOTES C1, §6 |
| 4 | `users` schema gets `roster: 'read-policy'`; names come from `travelers.displayName` | §5 `users` | NOTES C11 |
| 5 | `email/send` ignores `from` (platform sender `notifications@updates.app.space`); brand via subject/body; email caps in `src/lib/limits.ts` | §4, §6 lockTrip, §8.7, §11 | NOTES C5 |
| 6 | `anthropic/chat-completion` calls pass `claude-haiku-5-5` and `max_tokens` ≈ 600 explicitly | §4, §6 suggestCandidates | NOTES C10 |
| 7 | `serpapi`, `anthropic`, `email` marked `serverOnly`; browser proxy returns 403 for them; api tests for serpapi/flights and email/send | §11, §12 | NOTES C4 |
| 8 | JobRoom `authorizeWrite`/`authorizeRead` admin-only; progress copied to new `trips` columns `searchJobId`, `searchProgress`, `searchMessage`, `searchError`; clients don't use `useJobs` | §3.5, §4, §5 `trips`, §6 startSearch, §8 | NOTES C3 |
| 9 | `/ws/cron` and `/ws/jobs` pinned to `app:${DEEPSPACE_APP_ID}`; cron writes admin-only | §4, §9 | NOTES C7 |
| 10 | Jobs/cron/actions share `createAppTools(env, actingUserId, callerJwt?)` instead of `buildCronContext`; job identity and room id resolved | §4, §6, §8, §9 | NOTES C8, §2 |
| 11 | Fixture seam for fare search gated on `ALLOW_DEBUG_ROUTES === 'true'` AND a `__test-` trip name, with a unit test for the real path | §8 | NOTES C12 |
| 12 | Exactly one real `serpapi/flights` call in Phase 2 (ORD,MDW → BNA, Dec 11–13) to save the fixture | §7 Fare selection | NOTES C13 (developer decision 5) |
| 13 | Known limitation recorded: `'collaborator'` read includes `createdBy` on collections without `ownerField`; accepted because leave-trip isn't being built | §5 Known limitation | NOTES §4 |
| 14 | Job failure/retry handling (idempotent, emails deduped, status rolled back on final failure); `enqueueJob` failure handling in `startSearch` | §6 startSearch, §8.7–8.9 | NOTES C13, §5 |
| 15 | Cron: "open the app once after deploy" replaced by automatic arming + log check; `where` is equality-only, so status/date filtered in code | §9 | NOTES C9, C13 |
| 16 | Column-type conventions (date/datetime/json/0-1) and `hasBudget`/stray-budget handling written down | §5 | NOTES C13 |

### 2026-11-20 — Phase 2 decisions (approved by the developer)
| # | Change | Where in this spec | From |
|---|---|---|---|
| 17 | The one real SerpApi call failed (provider 429, billing released). `flights.ts` is written against SerpApi's published format with a hand-made fixture; re-check with a real response before Phase 5 ships | §7 Fare selection | AGENT_LOG Phase 2 |
| 18 | Home pair: candidate = a home airport → price 0, status ok, stops 0, no API call; excluded from arrival spread | §7 step 0, §8.2 | developer decision |
| 19 | Integration failures classified: `provider_unavailable` (429 / out of searches: no retry, no further calls, not counted in `usage`, human message in `searchError`) vs `error` | §7 Integration failures, §8.9 | developer decision |
| 20 | Booking URL: use SerpApi's URL only when it carries a search; otherwise build a `?q=` Google Flights URL. Defensive parsing; outbound-only times | §7 steps 5–6 | SerpApi docs |
| 21 | Approved Phase 2 choices: incomplete candidates have blank totals and sort last; watch checks capped at 3/trip/day (separate from the 2 full searches); under-budget email only on an above→at-or-below crossing; midpoint excludes home airports. Caps live in `src/lib/limits.ts` | §7, §8, `src/lib/limits.ts` | AGENT_LOG Phase 2 |
