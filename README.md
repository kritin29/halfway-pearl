# Halfway

**Friends in different cities find the fairest place to meet.** Everyone joins one shared trip from their own phone, enters their own home airports and flight rules, and (optionally) a **private budget** nobody else can see. Halfway checks every traveler's fare to every candidate city, ranks the cities three ways (cheapest, fairest, arriving together), lets the group vote and lock one, gives each person their own booking link, and then **watches the fares every morning** and emails when the trip gets cheaper.

Live (once deployed): `https://halfway-pearl.app.space` · Source: this repo.

---

## Why it exists

Multi-origin "where should we meet" search already exists: **MeetPoint**, **Kayak Rendezvous**, Betweengs and Midway all answer "which city is cheapest for these origins?". They are **single-player calculators**: one person types everyone's cities, runs one search, and pastes a screenshot into the group chat.

Group trips rarely fail on search. They fail on **coordination**:

| What goes wrong in the group chat | What Halfway does |
|---|---|
| Nobody wants to say "I can only afford $300" in front of everyone | **Private budgets**: only you see yours; the group sees "budget set ✓" |
| One person has to collect everyone's airports, dates and dealbreakers | **Everyone enters their own** constraints, live |
| Prices move after the first search | **Daily fare watch** with group and private email alerts |
| Half the group lands at 9 AM and half at 11 PM | **Arrival alignment**: a "Together" ranking by arrival spread |
| Half the group never books | **Lock + per-person booking links + a live "who's booked" checklist** |

Halfway is the coordination layer. Flight search is one component of it.

## Features

- **Trips with invite links.** Up to 8 travelers. The organizer can add **ghost travelers** (name + home airport) for people who won't use the app, which also lets one person try the whole flow alone.
- **Your own settings.** 1–3 home airports, max stops, no red-eyes, earliest departure hour.
- **Private budget.** Stored in a collection only its owner can read. Each person privately sees "your fare vs your budget".
- **Destinations.** Up to 6: AI suggestions from the trip's "vibe" (validated against a bundled airport list), the geographic middle of everyone's airports, or search-and-add.
- **Find fares.** A background job checks every traveler × destination in parallel; fares appear live on every member's screen with a progress bar.
- **Ranked results.** Tabs **Cheapest** (group total), **Fairest** (lowest worst-off fare), **Together** (smallest arrival spread). Each card: group total, each person's fare with stops/times/airline, Google's "low / typical / high" price badge, "Everyone lands within 1h 40m", and "Fits everyone's budget" (see the privacy model).
- **Approval voting** with a live tally, then the organizer **locks** a destination: every real member gets an email with their own fare and Google Flights link, and the Book tab shows a live checklist.
- **Daily fare watch.** Every morning at 8:00 (America/Chicago) the shortlist (the locked city, or the top 3 by votes) is re-checked. A group-total drop of at least max($50, 5%) emails everyone; your own fare dropping under your budget emails only you (once per destination). "Check fares now" runs the same check on demand. A sparkline shows the group total over time.
- **A "next step" guide** on every trip (airports → destinations → fares → vote → lock → book) that follows the trip's state live.
- **Demo trips.** "Try a demo trip" on Trips opens a ready-made trip with sample prices, labelled as such everywhere (see [Demo mode](#demo-mode)).
- **Graceful provider outages.** If the flight-data provider is out of quota, the trip shows a plain-language banner, nothing is retried in a loop, a search the outage stopped before anything was fetched or billed is given back to the daily limit, and the rest of the app keeps working.

## How to use it

1. Sign in and open **Trips**. Create a trip: name, outbound and return dates, an optional vibe ("beach, cheap, not Florida").
2. On the **Crew** tab, add your home airports and (optionally) your private budget. Copy the invite link to your friends. **Trying it solo?** Press **Add traveler** twice to add two ghost travelers with home airports in other cities.
3. On **Destinations**, ask AI for ideas, add the geographic middle, or search for a city.
4. The organizer presses **Find fares**. Results fill in live.
5. On **Results**, compare the three rankings and vote. The organizer locks the winner.
6. On **Book**, open your Google Flights link, book, and tick "I've booked my flight". The fare watch keeps running until the day before departure.

The guide at the top of each trip always says which of these steps is next.

## Demo mode

**Why it exists.** Halfway gets flight prices from SerpApi (Google Flights) through the DeepSpace platform. For this entire build, the platform's shared SerpApi account has been out of searches: every real call (Nov 20, a retry on Nov 21, and another on Nov 23) came back `SerpAPI error 429: "Your account has run out of searches."` (billing released, so nothing was charged). That isn't a bug in Halfway, but it means a reviewer pressing **Find fares** on a real trip sees the provider-outage banner and no prices. Demo mode exists so the rest of the product can still be seen working. It is not a substitute for live fares, and it says so on every screen.

**What it does.** On **Trips**, press **Try a demo trip**. You get a trip where you're the organizer flying from Chicago (ORD), with two ghost travelers, Sam in Boston and Priya in Denver, four destinations (Austin, Nashville, San Diego, Miami), and the normal fare search already running. Results arrive in a few seconds. From there everything is the real app: the three rankings, voting, locking, the Book tab and its checklist, "Check fares now". You can also edit your own airport and settings and press Find fares again.

**What's different, and how it's enforced:**

- **Sample prices, never live ones.** A demo trip's fares come from a saved, hand-made SerpApi-format fixture (`src/lib/__fixtures__/serpapi-flights-sample.json`), rewritten per route so destinations rank differently. The fare-search job never calls `serpapi/flights` for a demo trip, in any environment. Sample answers are cached only under that trip's own keys, so a demo price can never show up on a real trip.
- **Labelled everywhere.** "Demo trip: sample prices, not live fares." is on the trip banner (above every tab), every result card, every Book tab card, the fare-watch card, the trip's card on **Trips**, and the invite page.
- **No email, ever.** Locking, "Email booking links again" and fare-watch alerts send nothing for a demo trip, and the UI says "Emails are off in demo trips." The email sender also refuses demo trips outright, as a backstop.
- **Not watched daily.** The morning cron skips demo trips, and the daily switch is hidden; "Check fares now" re-checks the sample prices. They're fixed per route, so the sparkline stays flat.
- **Only the server can make one.** `trips.isDemo` is set by the `createDemoTrip` action alone, is immutable after creation, and clients can't write trips at all.
- **Capped.** 3 demo trips per user per day. They cost nothing, but the cap stops anyone from flooding storage.

## Architecture

A DeepSpace app: React (Vite) on the client, a Cloudflare Worker with Durable Objects on the server, deployed with `npx deepspace deploy`.

```
Browser (React)                         Worker (Hono)                         Durable Objects
─────────────────                       ─────────────                         ───────────────
useQuery / useMutations  ── WebSocket ─────────────────────────────────────▶  RecordRoom  app:<appId>
  (RBAC-filtered reads,                                                        (all collections, RBAC
   own travelers/budgets rows)                                                  evaluated in the DO)
callAction(name)         ── POST /api/actions/:name ─▶ server actions ──▶ tools (RBAC off) ──▶ RecordRoom
                                                         │  enqueueJob('fare-search')
                                                         ▼
                                                       JobRoom app:<appId> ─▶ fare-search job ──▶ serpapi/flights
                                                       CronRoom app:<appId> ─▶ fare-watch (08:00 CT) ─▶ enqueue watch runs
                                                       integrations: serpapi, anthropic, email (server-only, owner-billed)
```

### Rooms

- **RecordRoom `app:<appId>`**: one room for the whole app. Trip privacy comes from row-level RBAC, not from separate rooms: every trip-scoped row carries `memberIds` (the `collaboratorsField`), and `read: 'collaborator'` means the room only ever sends a row to people on that trip.
- **JobRoom**: runs `fare-search`. Read and write are **admin-only**, so members can't see other trips' job payloads or enqueue searches around the caps; the job copies progress onto the trip row instead (`searchProgress`, `searchMessage`).
- **CronRoom**: runs `fare-watch` daily. Cron and job socket routes only accept the app's own room id (any other id would spin up a second schedule), and cron writes are admin-only.

### Collections and who can read them

| Collection | Who can read | Who writes |
|---|---|---|
| `trips` | trip members | server actions only |
| `travelers` (public constraints) | trip members | actions create rows; each user updates **only their own row**, only these fields: airports, stops, red-eye, earliest hour, `hasBudget`, `booked` |
| `budgets` (**private**) | **the owner only** (the app owner/admin too sees only their own) | the owner |
| `candidates`, `fares`, `votes`, `fareSnapshots` | trip members | actions and the job |
| `fareCache` (route cache, no user data) | nobody (server only) | the job |
| `emailLog` (send dedupe, no addresses) | nobody (server only) | actions, the job |
| `usage` (spend ledger) | nobody (server only) | actions, the job, the cron |
| `users` | your own row | platform |

Rule of thumb: any row carrying `memberIds` is written only by server code. Identity always comes from the verified JWT; no action accepts a user id from the client.

### Server actions (`src/actions/`)

Every action loads the trip, checks the caller is a member (or the organizer), validates its input, then writes. Actions run with RBAC off, so these checks are the security boundary.

| Action | Who | What |
|---|---|---|
| `createTrip`, `previewInvite`, `joinTrip` | signed in | create; preview an invite (name/dates only); join (idempotent, max 8, not once locked) and propagate `memberIds` to every trip row |
| `createDemoTrip` | signed in | a demo trip (sample fares, no emails), 3 per user per day; starts the normal search |
| `addGhost`, `updateGhost`, `removeGhost` | organizer | ghost travelers (and ticking a ghost as booked) |
| `addCandidate` | member | search-and-add a destination |
| `suggestCandidates`, `addMidpointHubs`, `removeCandidate` | organizer | AI ideas, geographic middle, remove (with its fares, votes, snapshots) |
| `startSearch` | organizer | cap checks, then enqueue the full fare search |
| `toggleVote` | member | your own approval vote |
| `lockTrip` | organizer | lock a complete destination and email each real member their own booking link; calling it again resends only what's missing |
| `setWatch`, `checkFaresNow` | organizer | daily watch on/off; a watch check on demand |

### The fare-search job (`src/server/fare-search.ts`)

1. Build traveler × destination pairs. A destination that is one of your home airports costs $0 with no call. Travelers with the same set of home airports share one call.
2. Check the spend caps **before** any call; reuse any route fetched in the last 6 hours from `fareCache`.
3. Call `serpapi/flights` four at a time, apply each traveler's own constraints, write each fare row as it arrives, and throttle progress onto the trip row.
4. Rank with `src/lib/ranking.ts` (reads budgets server-side), write the destination aggregates and one `fareSnapshots` row per destination.
5. **Watch mode** re-checks only the shortlist, never changes the trip's status, keeps the previous fare for any route it couldn't answer, and sends drop / under-budget emails through one deduplicated sender (`deliverOnce`: claim an `emailLog` row, check caps, send).
6. Provider outage (HTTP 429 / "run out of searches"): stop calling, don't retry, don't count the failed call, show the banner, and give back the trip's daily search if nothing was fetched or billed.

The job is idempotent (deterministic row ids), so a JobRoom retry can't duplicate rows or emails.

### The cron (`src/cron.ts`)

`fare-watch` at `0 8 * * *` America/Chicago: trips with the watch on (never demo trips), status results or locked, departing more than a day from now; soonest first, at most 10 per run; once per trip per day; subject to the same caps as "Check fares now". It enqueues watch runs of the same job.

### Integrations

All three are `billing: 'developer'` (the app owner pays), require sign-in (never `anonymous`), and are marked **`serverOnly`**: the browser integration proxy answers **403** for them, so they're reachable only from actions/jobs/cron after the cap checks (an api test proves it for `serpapi/flights` and `email/send`).

| Integration | Why | Cost |
|---|---|---|
| `serpapi/flights` | Google Flights results, including Google's `price_insights` ("low / typical / high"), with no API key to manage | $0.0325 per call |
| `anthropic/chat-completion` | Turns a vibe + everyone's airports into destination ideas. Always `claude-haiku-5-5` with `max_tokens` 3000 (the endpoint defaults to Opus); the output is parsed defensively and only airports from the bundled list are kept | ≈ $0.0006 per call (observed) |
| `email/send` | Booking links on lock, fare-drop and under-budget alerts. Mail comes from the platform sender; "Halfway" is in the subject and body | $0.013 per email |

**Deliberately left out:**

- **Weather**: forecasts cover a few days; trips are planned weeks out, so it would mislead.
- **Hotels** (`serpapi/hotels`): useful, but doubles search spend; listed under what's next.
- **Maps**: a map would be decoration; airports and arrival times carry the decision. The landing's route map is drawn in code.
- **Image generation**: no product need; every visual is SVG/React.
- **Voice/LiveKit, canvas, payments, AI chat**: no user value for this flow.

## Privacy model

- **Budgets are private by RBAC, not by UI.** `budgets` is `read: 'own'` for every role, so the Durable Object never sends someone else's budget row to a browser, an agent tool, or the app owner. Server code reads budgets only to compute rankings and the private alert.
- **The 3-budget guard.** "Fits everyone's budget" is computed server-side but stored as hidden (`null`) unless **at least 3 travelers have set budgets**. With only two, a "doesn't fit" badge would tell you the other person's budget is below your shared fare. With three or more, nobody can tell who is the constraint. Each person still sees their own fit privately.
- **Emails never contain a budget.** The template builder doesn't take one as input. The under-budget email goes only to that person and says "within the budget you set", not the amount.
- **No roster leak.** `users` uses `roster: 'read-policy'`, so names come from each trip's own `travelers` rows, not a list of every user.
- **Two-user tests prove it**: another account can't read your budget through `useQuery` or the agent tool route, a non-member can't see a trip, and nobody can read `usage`.

## Spend controls

All caps live in `src/lib/limits.ts` and are checked (in `usage`) **before** any paid call.

| Cap | Value | Worst-case cost |
|---|---|---|
| SerpApi calls per run | 30 | $0.98 per run |
| Full searches per trip per day | 2 | |
| Watch checks per trip per day (cron + "Check fares now") | 3 | |
| Trips one user may start searching per day | 3 | |
| SerpApi calls per day, whole app | 80 | **$2.60/day** |
| AI suggestions per user per day | 5 | ≈ $0.003 per user per day |
| Emails per trip per day / whole app per day | 20 / 100 | **$1.30/day** |
| Trips created per user per day | 10 | (abuse cap; free) |
| Demo trips created per user per day | 3 | (abuse cap; demo trips make no paid calls) |

Plus: a 6-hour route cache shared across trips, one call per identical set of home airports, $0 home pairs, at most 6 destinations × 8 travelers, and no retry on provider outages. A 3-traveler × 4-destination search makes at most 12 calls ($0.39); a repeat within 6 hours makes none. Counters are soft by ±1 under concurrency (get-then-update), which the caps' size absorbs.

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit (Vitest) | `npx deepspace test run unit` | Pure logic: fare parsing and constraint filtering against a saved fixture, ranking and the 3-budget guard, caps and the refund rule, fare-watch decisions (shortlist, drop threshold, first crossing), email templates (no budget, escaping, one recipient), validation, the next-step guide. Server code against a fake store: demo trips (never reach `serpapi/flights` or `email/send` even with the production code path, the flag can't be set by clients or changed later, the 3/day cap, excluded from the cron, demo prices never reach a real trip), every action's membership/organizer checks, the fare-search job (dedupe, cache, caps, outages, retries, mid-run joins), lock and watch emails (dedupe, caps, mocked seam), the cron, and the schema permission matrix (incl. `budgets` own-only and `usage` all-false) |
| Smoke + API | `npx deepspace test run` | Static landing (no auth call, no websocket, real content and title), nav, 404, `/home` redirect; every action → 401 without a token and not-found for non-members; **403 on the browser integration proxy** for server-only integrations; job/cron socket lockdown; **one real AI call** and **one real `email/send` call** |
| E2E (two users) | `npx deepspace test run e2e` | Create → invite → join with live updates; budget privacy; non-member can't see a trip; destinations live; fare search with live progress, ranking tabs and votes; lock → emails (mocked) → live booked checklist; fare watch (check now → snapshot → both sparklines update live, cap refusal, toggle); the next-step guide through all six stages on the solo path; a solo **demo trip** from the real button (results, sorting, vote, lock with emails off, check fares, the label on every screen, client can't write `isDemo`); a failed invite lookup retries without reloading the page |

Rules followed: at most one real call per integration per run, never in loops; mocks only at the integration boundary. Playwright can't intercept worker-side calls, so `__test-` trips are answered from the saved SerpApi fixture and have their emails built but not sent, **only** when `ALLOW_DEBUG_ROUTES === 'true'` (set by `deepspace dev`/`test run`, never in production). A unit test proves the real path is taken without the flag.

Two-user tests need two pool accounts: `npx deepspace test accounts create --email <name>@deepspace.test --name "<Name>" --password-stdin`.

## Run and deploy

```sh
npm install
npx deepspace auth login        # once
npx deepspace dev start         # local app (vite + miniflare)

npx deepspace test run unit     # unit
npx deepspace test run          # smoke + api (makes 1 real AI call and 1 real email)
npx deepspace test run e2e      # two-user specs
npx tsc --noEmit && npx eslint .

git commit …                    # deploy ships the working tree, so commit first
npx deepspace deploy            # → https://halfway-pearl.app.space
# Cron proof: the CronRoom's run history, not the logs (alarm-time output isn't in `deepspace logs`).
# A read-only socket to wss://halfway-pearl.app.space/ws/cron/app:<DEEPSPACE_APP_ID> receives
# `cron.tasks` (lastRunAt, nextRunAt) and `cron.history`.
```

Source control is plain Git with GitHub as the source of truth (the DeepSpace cloud repo commands are not used).

## Known limitations

- **SerpApi quota outage during development.** Every real `serpapi/flights` call so far (Nov 20, Nov 21, Nov 23) returned `SerpAPI error 429: "Your account has run out of searches."` with billing released. No real flight response has been seen; [demo mode](#demo-mode) exists because of this.
- **The flight parser is built from SerpApi's published docs**, tested against a **hand-made** fixture that follows them, and not yet checked against a real response. The first real search in production is the first real check; the field names (`best_flights`, `other_flights`, `price_insights`, `layovers`, times) should be cross-checked then.
- **Concurrency is tested with fakes.** Concurrent joins, the 6-destination limit under two writers, the email claim pattern and job retries are tested with a fake store and a fake job context, not against the real Durable Objects under load. Spend counters are soft by ±1.
- **The cron has run once on the deployed app** (2026-11-23 08:00 CT, success, per the CronRoom history). It first deployed after the Nov 22 slot had passed. With the quota out, no watched trip can get new prices yet.
- **Demo prices are illustrative.** They come from a hand-made fixture, not observed fares, and are fixed per route, so a demo never shows a price drop.
- **Real email delivery is unconfirmed.** The one real send was accepted by the platform, but the test address is on the reserved `@deepspace.test` domain.
- **Read access by `createdBy`.** On collections without an `ownerField` (candidates, fares, fareSnapshots), the row's creator keeps read access. Harmless today because nobody can leave a trip.
- **Times are outbound-only** (return legs need a second request per itinerary), so red-eye and arrival alignment use the outbound flight; prices are round-trip.
- **Fonts load from Google Fonts**, so visitors' browsers make a request to Google.
- Phone layouts were checked at 390px in headless Chromium, not on a physical phone.

## What's next

1. Re-run the single approved SerpApi call when the quota is back and reconcile `src/lib/flights.ts` with the real response.
2. Hotels total per destination (`serpapi/hotels`), behind its own caps.
3. Flexible dates (±1 day) and a "nudge the unbooked" reminder email.
4. Leave trip and delete trip (needs `ownerField: 'tripId'` on the server-written collections first, and a cascading `deleteTrip`).
5. Load-test the concurrency paths against real Durable Objects.

---

Project docs: `SPEC.md` (product and technical spec), `NOTES.md` (DeepSpace research and decisions), `AGENT_LOG.md` (phase-by-phase build log).
