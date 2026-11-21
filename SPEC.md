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
5. Organizer clicks **Find fares** → background job searches each traveler × candidate in parallel, results stream in live on every member's screen.
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
| Parallel fare search | **JobRoom** job (`src/jobs.ts`) | Outlives the request, reports progress, retries |
| Daily fare watch | **CronRoom** task (`src/cron.ts`) | Durable schedule with history/logs |
| Flights | `serpapi/flights` integration | Google Flights data + `price_insights`, no API key |
| Destination ideas | `anthropic/chat-completion` integration | Turns a vibe into candidates; output is validated |
| Alerts & booking links | `email/send` integration | Sender `<app-slug>@app.space` |

**Deliberately not used** (say this in the writeup): weather (forecasts only cover a few days; trips are weeks out → misleading), hotels (stretch goal only), maps integration (optional MapLibre client-side visual, no integration needed), voice/LiveKit/canvas/payments (no user value here).

## 5. Data model (collections)

Rule of thumb: **any row that carries `memberIds` is written only by server actions or jobs.** Clients write only their own constraint row and their own budget row.

All trip-scoped collections include `tripId` (text) and `memberIds` (text, JSON array of user ids, `collaboratorsField`). Ghost travelers have ids like `ghost:<uuid>` and are never in `memberIds`.

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

Permissions: `member: { read: 'collaborator', create: false, update: false, delete: false }`, `admin: all true`. (All writes via actions.)

### `travelers` (public per-person constraints)
| column | type | notes |
|---|---|---|
| tripId, memberIds | | |
| userId | text | `ownerField`, `userBound` for real users; ghosts written by action |
| isGhost | number 0/1 | |
| displayName | text | |
| homeAirports | text (json array of IATA) | 1–3 codes, validated |
| maxStops | number | 0, 1, 2 (2 = any) |
| noRedeye | number 0/1 | |
| earliestDepartHour | number | 0–23, default 0 |
| hasBudget | number 0/1 | set by the client when it saves a budget |
| booked | number 0/1 | |

Permissions: `member: { read: 'collaborator', create: false, update: 'own', delete: false, writableFields: ['homeAirports','maxStops','noRedeye','earliestDepartHour','hasBudget','booked'] }`.
Ghost rows: created/edited only via organizer actions.

### `budgets` (PRIVATE)
| column | type | notes |
|---|---|---|
| tripId | text | |
| userId | text | `ownerField`, `userBound` |
| maxUsd | number | > 0 |

`uniqueOn: ['tripId','userId']`. Permissions: `member: { read: 'own', create: true, update: 'own', delete: 'own' }`. No `memberIds` column. **Only the owner and server code can read it.**

### `candidates`
tripId, memberIds, iata, city, country, why (text), source (select: ai, midpoint, manual), addedBy, plus aggregates written by the search job: `complete` (0/1), `groupTotal`, `maxFare`, `minFare`, `arrivalSpreadMin`, `fitsAll` (0/1/null — see §7), `missingFor` (json array of displayNames), `lastCheckedAt`.
Permissions: read `'collaborator'`, writes server-only.

### `fares`
tripId, memberIds, candidateIata, travelerId (userId or ghost id), originIata (the airport actually used), price, priceLevel (low/typical/high/unknown), typicalLow, typicalHigh, stops, durationMin, departLocal, arriveLocal (outbound leg, ISO-ish local time strings), airline, bookingUrl, status (select: ok, no_results, filtered_out, error), fetchedAt.
Permissions: read `'collaborator'`, writes server-only.

### `votes`
tripId, memberIds, userId (`ownerField`), candidateIata. `uniqueOn: ['tripId','userId','candidateIata']`. Read `'collaborator'`; writes via `toggleVote` action.

### `fareSnapshots`
tripId, memberIds, candidateIata, groupTotal, maxFare, checkedAt. Read `'collaborator'`; server-only writes. Drives the "price over time" sparkline and drop detection.

### `usage` (server-only spend ledger)
day (YYYY-MM-DD), key (e.g. `serpapi:global`, `serpapi:trip:<id>`, `ai:user:<id>`), count. All roles `read/create/update/delete: false`. **Verify with a test that a client cannot read it** — the permissions doc doesn't present an explicit "server-only" flag.

## 6. Server actions (`src/actions/index.ts`)

Every action: (1) load the trip with `tools.get`, (2) check the caller is in `memberIds` (or is `organizerId` where noted), (3) validate params, (4) write. Never trust ids from params without loading and checking. Return `{ success, data }` / `{ success: false, error, code }`.

| action | who | does |
|---|---|---|
| `createTrip({name, outboundDate, returnDate, vibe})` | any signed-in | creates trip (memberIds=[caller]), inviteCode, caller's traveler row |
| `joinTrip({inviteCode})` | any signed-in | adds caller to trip.memberIds, creates traveler row, **propagates new memberIds to every trip-scoped row** (travelers, candidates, fares, votes, fareSnapshots). Idempotent. Max 8 travelers incl. ghosts |
| `addGhost({tripId, displayName, homeAirports, ...})` / `updateGhost` / `removeGhost` | organizer | ghost traveler rows |
| `addCandidate({tripId, iata})` | member | validates IATA against `src/data/airports.json`; max 6 |
| `suggestCandidates({tripId})` | organizer | AI → JSON → validate each IATA → insert up to (6 − existing). Cap: 5 AI calls per user per day (`usage`) |
| `addMidpointHubs({tripId})` | organizer | deterministic: centroid of travelers' home airports (lat/lon) → nearest 2 "major" airports not already candidates |
| `removeCandidate({tripId, iata})` | organizer | also deletes its fares/votes |
| `startSearch({tripId})` | organizer | checks caps, sets status=searching, `enqueueJob(env.JOB_ROOMS, \`app:${env.DEEPSPACE_APP_ID}\`, 'fare-search', {tripId, mode:'full'}, {maxAttempts: 2, enqueuedBy: userId})` |
| `toggleVote({tripId, iata})` | member | upsert/delete own vote |
| `lockTrip({tripId, iata})` | organizer | status=locked, lockedIata; emails each real member their booking link |
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
1. Call `serpapi/flights` with `departure_id` = traveler's home airports comma-joined (e.g. `ORD,MDW`), `arrival_id` = candidate IATA, `outbound_date`, `return_date`, `type: '1'` (round trip; SerpApi uses 1 = round trip, 2 = one way), `adults: 1`, `currency: 'USD'`, `hl: 'en'`. Cost: **$0.0325 per call** (from `integrations info`, Nov 20).
2. Merge `best_flights` + `other_flights`. Apply constraints: stops ≤ maxStops (layovers count), drop red-eyes if `noRedeye` (outbound departs 21:00–04:59 local or arrives next day), drop departures before `earliestDepartHour`.
3. Pick the cheapest remaining → fare row. If none remain but results existed → `filtered_out`; if no results → `no_results`.
4. Copy `price_insights.price_level` and `typical_price_range` when present.
5. `bookingUrl`: use `search_metadata.google_flights_url` if present in the raw response; otherwise build a Google Flights search URL.

**Verify field names against the saved fixture** — the proxy returns the raw SerpApi JSON; don't assume.

## 8. Background job: `fare-search` (`src/jobs.ts`)

Payload `{ tripId, mode: 'full' | 'watch' }`.
1. Load trip, travelers, candidates (`mode:'watch'` → only top 3 by votes, or the locked one).
2. Build pairs (traveler × candidate). Dedupe identical (origin set, destination, dates) — two friends from Chicago share one call.
3. **Spend caps before any call** (at $0.0325/call): ≤ 30 calls per run (≤ $0.98), ≤ 2 full searches per trip per day, ≤ 3 trips started searching per user per day, global ≤ 80 serpapi calls per day (≤ $2.60/day, ≤ ~$13 over the review window). Put these numbers in one constants file so they're easy to tune. Increment `usage` per call.
4. Cache: reuse a fare fetched < 6h ago for the same key (full mode only).
5. Run calls with small concurrency (e.g. 4 at a time), write each fare row as it arrives (live fill-in), `ctx.progress(done/total, 'Checked ORD→BNA')`, honor `ctx.signal`.
6. Compute aggregates with `ranking.ts` (needs budgets — server-side read) and update candidates; write a `fareSnapshots` row per candidate.
7. `mode:'watch'`: compare with the previous snapshot → group drop email; per-traveler private "now under your budget" email (only when crossing the threshold, not every day).
8. Set trip status=results (unless locked), lastSearchAt.

How a job reaches integrations/records: confirm in docs/types (options: `buildCronContext(env, env.OWNER_USER_ID, app scope)` gives `records` + `integrations.call`; or the action-tools pattern). Jobs run as the app owner and bill the owner.

## 9. Cron: `fare-watch` (`src/cron.ts`)

`{ name: 'fare-watch', schedule: '0 8 * * *', timezone: 'America/Chicago' }` → query trips with watchEnabled=1, status in (results, locked), outboundDate > today + 1 → enqueue `fare-search` `{mode:'watch'}` for each (max 10 trips per run). The cron alarm arms on the first request after deploy — open the app once after each deploy.

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

`serpapi`, `anthropic`, `email` → `billing: 'developer'` (default) with **sign-in required** (do not set `anonymous: true`). Paid calls only from server actions/jobs, never directly from the client.

## 12. Acceptance criteria (what "done" means)

- [ ] Two real accounts can create/join a trip and see each other's constraint updates live.
- [ ] Account B cannot read account A's budget via `useQuery('budgets')` or any action (automated two-user test).
- [ ] A non-member cannot see a trip (automated test).
- [ ] Find fares fills results live; ranking tabs reorder correctly (unit-tested).
- [ ] fitsAll hidden with < 3 budgets; shown with ≥ 3 (unit-tested).
- [ ] Caps prevent > 30 calls per run and > 2 full searches per trip per day (unit-tested cap logic).
- [ ] Lock sends booking emails; Book tab checklist updates live.
- [ ] "Check fares now" writes a snapshot and sends a drop email when the total falls (drop logic unit-tested).
- [ ] Deployed at `<slug>.app.space`; works on a phone.

## 13. Stretch (only after acceptance criteria pass)

Hotels total (`serpapi/hotels`), flexible dates (±1 day), MapLibre map of origins/candidates, "nudge unbooked" reminders, leave trip.
