# Halfway: phase-by-phase plan with Claude Code prompts

How to use this file:
- Do the phases in order.
- For each phase: paste the prompt into Claude Code, let it work, then do the **You verify** checklist yourself.
- Write what you found in `AGENT_LOG.md` under "Me". Commit. Deploy at the marked checkpoints.

Deadline: **Tue Nov 24, 11:59 PM ET = 10:59 PM CT.** Target your final deploy by **Tue 6 PM CT**.

---

## Phase 0: Setup (you, by hand) · Fri night · ~1–1.5 h

You do these yourself. They involve logins and decisions only you can make.

```bash
# 0.1 Runtime: needs Node 22.15+ (or 24/26) and npm 11.6+
node --version
npm --version
npm install -g npm@11            # if npm < 11.6

# 0.2 Log in to DeepSpace (opens a browser)
npx deepspace auth whoami --json  # if signed out:
npx deepspace auth login

# 0.3 Scaffold (pick your slug; it becomes <slug>.app.space)
npm create deepspace@latest halfway-<yourname>
cd halfway-<yourname>

# 0.4 GitHub as the source authority. Do this BEFORE the first deploy,
#     and NEVER run `npx deepspace push`.
git init -b main 2>/dev/null; git add -A; git commit -m "Scaffold DeepSpace app"
#   Create an EMPTY repo on github.com (no README), then:
git remote add origin git@github.com:<you>/halfway-<yourname>.git
git push -u origin main
npx deepspace app source --json   # should say unclaimed

# 0.5 First deploy: the bare scaffold, to prove the pipeline works
npx deepspace deploy
npx deepspace app source          # should now show your GitHub repo
#   Open https://<slug>.app.space and sign in once (this also arms the cron later)

# 0.6 Check the integrations you'll use (exact schemas and prices)
npx deepspace integrations info serpapi/flights
npx deepspace integrations info anthropic/chat-completion
npx deepspace integrations info email/send

# 0.7 Test accounts for two-user tests (emails must end in @deepspace.test)
#     Emails are GLOBAL across all DeepSpace developers, so add a unique suffix
npx deepspace test accounts create --email alice-<yourhandle>-1@deepspace.test --password '<pick-one>' --name "Alice"
npx deepspace test accounts create --email bob-<yourhandle>-1@deepspace.test   --password '<pick-one>' --name "Bob"
```

Then:
- Copy `SPEC.md`, `CLAUDE.md` (it replaces the scaffold's one-line file), `AGENT_LOG.md`, `PROMPTS.md`, and `SUBMISSION_NOTE.md` into the repo root.
- Commit and push.
- Start Claude Code in the repo: `claude`.

**You verify:**
- [ ] `<slug>.app.space` loads.
- [ ] `app source` shows GitHub.
- [ ] You wrote down the price per call for `serpapi/flights` (from `integrations info`) and your account's credit situation.

---

## Phase 1: Orientation (no code) · Fri night · ~30 min

```
Read CLAUDE.md, AGENTS.md and SPEC.md fully. Then read these DeepSpace docs as markdown:
/concepts/architecture, /concepts/data-model, /concepts/permissions, /concepts/realtime-sync,
/guides/server-actions, /guides/background-jobs, /guides/scheduled-jobs, /guides/external-apis,
/guides/testing (from https://docs.deep.space, append .md). Also inspect the scaffold:
worker.ts, src/schemas.ts, src/schemas/*, src/actions/index.ts, src/server/action-routes.ts,
src/jobs.ts, src/cron.ts, src/integrations.ts, src/pages/(app)/_layout.tsx, tests/*.

Do NOT write app code yet. Produce NOTES.md with:
1. Anything in SPEC.md that conflicts with the docs or installed types (be specific: quote the doc).
2. Exactly how a JobRoom job handler should call an integration and read/write records
   (which helper, which identity, which room id). Cite the type signature.
3. Whether a collection with all permissions false is unreadable by clients but writable by
   server actions (needed for the `usage` collection), and how we'll test that.
4. How 'collaborator' read works with collaboratorsField, and whether the owner (ownerField)
   is included automatically.
5. How to enqueue a job from a server action (env binding name, room id).
6. Whether `userBound` on travelers.userId blocks server actions from writing ghost rows
   (userId = 'ghost:<uuid>'), and if so, what we should do instead.
7. A proposed file list for the whole project.
Then stop and summarize.
```

**You verify:**
- [ ] Read NOTES.md yourself. Does each claim cite a doc or a type? Open 1–2 of the cited docs and confirm.
- [ ] Resolve any conflicts before Phase 3. Edit SPEC.md if needed.
- [ ] Log: what it got right, what it guessed.

---

## Phase 2: Real flight data and pure logic (TDD) · Sat morning · ~2–3 h

```
Phase 2. Goal: the pure logic, tested against REAL SerpApi data.
1. Run exactly ONE real call and save the raw response:
   npx deepspace integrations invoke serpapi/flights --body '{"departure_id":"ORD,MDW","arrival_id":"BNA","outbound_date":"<a Friday ~3 weeks out>","return_date":"<the Sunday after>","type":"1","adults":1,"currency":"USD","hl":"en"}'
   Save it to tests/fixtures/serpapi-flights-chi-bna.json. Show me the top-level keys and the
   shape of one best_flights item and of price_insights.
2. Create src/data/airports.json: ~250 major airports worldwide with iata, city, country, lat,
   lon, and "major": true for large hubs. Tell me your source and flag any you're unsure of.
3. Implement pure modules with Vitest tests (tests next to them or in src/lib/__tests__):
   - src/lib/flights.ts: parseFlights(raw, constraints) → chosen fare | {status}. Implements
     SPEC §7 "Fare selection" (stops, red-eye, earliest hour, cheapest pick, price insights,
     booking URL). Test against the fixture plus small hand-written edge cases.
   - src/lib/ranking.ts: aggregates and the three sort orders, fitsAll with the ≥3-budgets
     privacy guard, incomplete candidates last, arrival spread.
   - src/lib/caps.ts: decide whether a run may start and how many calls it may make,
     given usage counts (≤30/run, ≤2 full searches per trip per day, global daily cap).
   - src/lib/watch.ts: group drop detection (≥ max($50, 5%)) and per-traveler
     "first crossed under budget".
   - src/lib/midpoint.ts: centroid of origin airports → nearest N major airports
     (haversine), excluding existing candidates.
Run `npx deepspace test run unit` and show the output. Append to AGENT_LOG.md. Stop.
```

**You verify:**
- [ ] Open the fixture. Pick one flight and check its price and times against google.com/travel/flights for the same search (roughly matching is fine; prices move).
- [ ] Read `ranking.ts` line by line. You must be able to explain "Fairest" and the privacy guard in the live interview.
- [ ] Spot-check 5 airports in airports.json (codes and coordinates).
- [ ] Change one test expectation on purpose and confirm the test fails. This proves the tests actually test something.

---

## Phase 3: Data model, permissions, trips and joining · Sat afternoon/evening · ~4 h

```
Phase 3. Implement SPEC §5 collections in src/schemas/ (trips, travelers, budgets, candidates,
fares, votes, fareSnapshots, usage) and register them in src/schemas.ts. Use ownerField,
userBound, collaboratorsField, writableFields and uniqueOn as specified.
Implement server actions: createTrip, joinTrip (idempotent, propagates memberIds to all
trip-scoped rows, max 8 travelers), addGhost/updateGhost/removeGhost. Every action loads the
trip and checks membership/organizer first.
Pages (inside the (app) provider boundary, protected): /trips (list + create), /join/:code,
/t/:tripId with the Crew tab only: member/ghost list with chips, "Your settings" panel
(client writes own travelers row), "Your private budget 🔒" (client writes own budgets row and
sets hasBudget=1), invite link copy.
Tests:
- e2e two-user (deepspace/testing, users(2)): Alice creates a trip, Bob joins via the code,
  Bob's airport change appears on Alice's page live; Alice sets a budget and Bob's
  useQuery('budgets') does not contain it; a third context that isn't a member can't see the trip.
- Test that clients cannot read `usage`.
Run unit + e2e, show results. Append to AGENT_LOG.md. Stop.
```

**You verify (by hand, important):**
- [ ] Normal browser = account 1, incognito = account 2 (or your phone). Create, join, and edit airports. Do updates appear live?
- [ ] In account 2's browser devtools, set `localStorage.DEEPSPACE_DEBUG='1'`, reload, and watch the WebSocket messages. You must **not** see account 1's budget amount anywhere.
- [ ] Try to break it: call `joinTrip` with a wrong code; edit another person's traveler row from devtools (should be refused).
- [ ] Commit, push, `npx deepspace deploy`, and repeat the two-browser check on the live URL.
- [ ] Log what you checked and anything you fixed yourself.

**Checkpoint deploy #1.**

---

## Phase 4: Destinations · Sun morning · ~2–3 h

```
Phase 4. Destinations tab per SPEC §3.4 and §6:
- addCandidate (validate IATA against airports.json; max 6), removeCandidate (organizer; cascades
  fares/votes), addMidpointHubs (uses src/lib/midpoint.ts).
- suggestCandidates: anthropic/chat-completion via tools.integration. Prompt includes origins,
  dates, vibe and existing candidates; ask for strict JSON [{iata, city, country, why}], max 6.
  Parse defensively, drop any IATA not in airports.json, dedupe, fill only free slots.
  Cap: 5 AI calls per user per day (usage + caps.ts). Show the prompt to me in your summary.
- UI: candidate list with source tags (AI / Middle / Manual), "why" text, search-add box
  with airport autocomplete, buttons disabled until useMutations().ready, all four async states.
Test: unit tests for the AI-output parser (valid, junk, invalid IATA, duplicates). One api
test that calls anthropic/chat-completion once. Stop and summarize.
```

**You verify:**
- [ ] Try vibes like "beach, cheap" and "ski", and paste garbage. Are the suggestions sensible? Did invalid codes get dropped?
- [ ] Read the prompt. Tighten it yourself if needed, and log the change. This is a good "what I changed" item for the writeup.

---

## Phase 5: Fare search job and results · Sun afternoon/evening · ~4–5 h

```
Phase 5. Implement the `fare-search` job per SPEC §8 (mode 'full' only for now) and the
startSearch action. Use the approach recorded in NOTES.md for calling integrations and
records from a job. Enforce caps (caps.ts) BEFORE any call, increment usage per call, cache
6h, concurrency 4, write each fare as it arrives, ctx.progress with messages, honor ctx.signal,
then compute aggregates via ranking.ts and write candidates + fareSnapshots. Status:
searching → results.
UI: "Find fares" with live progress (useJobs), Results tab with Cheapest/Fairest/Together tabs,
cards per SPEC §3.6, per-person breakdown, price-level badges, "lands within" badge,
fitsAll badge (hidden when null), and the viewer's private "your fare vs your budget" line
computed client-side from their own budget row. Votes: toggleVote action + live tally.
Tests: e2e with the SerpApi call mocked at the integration boundary using the fixture (no
real calls in loops); assert progress then results appear for both users; assert caps
block a third full search the same day. Stop and summarize, including how many real
SerpApi calls a 3-traveler × 4-destination search makes.
```

**You verify:**
- [ ] Run one real search on the deployed app: 3 travelers (2 accounts + 1 ghost) × 3–4 destinations. Results should stream in on both screens.
- [ ] Compare one result with Google Flights by hand.
- [ ] Check the logs: `npx deepspace logs --follow --json`. Count the calls and confirm the caps hold.
- [ ] Set budgets on 3 travelers and confirm the fits badge appears; delete one and confirm it hides.

**Checkpoint deploy #2.** By Sunday night, your core flow is done.

---

## Phase 6: Lock, book and emails · Mon morning · ~2–3 h

```
Phase 6. lockTrip action (organizer): status=locked, lockedIata; email each real member via
email/send from '<slug>@app.space' with reply_to set to the organizer, containing their own
fare and bookingUrl. Book tab: locked destination, viewer's booking link, live group checklist
(members toggle their own `booked`), watch toggle (setWatch). Never include anyone's budget in
emails. Test lock + checklist with two users (mock email at the boundary in e2e; one real
email call in api spec). Stop and summarize.
```

**You verify:**
- [ ] Lock a trip on the live app. Did both real accounts get the email? Do the links open the right Google Flights search?

---

## Phase 7: Fare watch · Mon afternoon · ~3 h

```
Phase 7. Add mode 'watch' to fare-search (shortlist = top 3 by votes or the locked
destination), drop detection with src/lib/watch.ts, group drop email and private
under-budget email (only on first crossing; store what you need to know it was already sent).
checkFaresNow action (organizer, same caps). Cron task 'fare-watch' at '0 8 * * *'
America/Chicago enqueuing watch jobs (max 10 trips). Book tab: sparkline of groupTotal from
fareSnapshots. Tests: unit for watch logic; e2e for checkFaresNow writing a snapshot (mocked
boundary). Stop and summarize.
```

**You verify:**
- [ ] On the live app, click "Check fares now" twice and confirm a new snapshot and a sparkline point.
- [ ] Temporarily lower the drop threshold in a local test, not in prod, and see the email logic fire.
- [ ] After deploy, open the app once (this arms the cron). Tomorrow morning, check `npx deepspace logs --search cron`.

**Checkpoint deploy #3.**

---

## Phase 8: Polish · Mon evening · ~3 h

```
Phase 8. Read /design/overview, /design/anti-ai-gate and /design/product-polish (append .md).
Replace the placeholder landing and theme with a clean, distinctive look that fits a travel
coordination tool. Mobile-first pass on every tab. Empty states that teach the next step
("Add at least 2 travelers and 1 destination to find fares"). A "Try it solo" hint on
/trips: create a trip and add 2 ghost travelers to see the whole flow. README.md: what it is,
how to run, how to deploy, architecture diagram (text), DeepSpace primitives and
integrations used, and the privacy model. Stop and summarize.
```

**You verify:**
- [ ] Go through the whole flow on your phone. Fix anything clumsy yourself or with targeted prompts.
- [ ] Ask a friend to join a trip from their own phone, the real two-person test, and note what confused them.

---

## Phase 9: Ship · Tue · ~3–4 h, leave buffer

```
Phase 9. Run `npx deepspace test run`, `npx deepspace test run unit` and
`npx deepspace test run e2e`; fix failures. Run `npm run validate` and `npm run lint`.
Search the repo for secrets/tokens/passwords and confirm none are committed. List anything
unfinished honestly for the README "What's next" section. Stop.
```

Then you:
1. Commit, push, and `npx deepspace deploy`. Check the live app with two accounts. Open it once (this arms the cron).
2. Record a 60–90 s screen capture: two browsers side by side, create → join → private budget → find fares streaming → vote → lock → check fares now. Optional, but strong.
3. Fill in `SUBMISSION_NOTE.md` from your `AGENT_LOG.md`. Submit the URL, repo, and note in the portal **before 10:59 PM CT**.

---

## If you fall behind (cut in this order)

1. Sparkline (keep the snapshots, just show the "last checked" number)
2. Private under-budget email (keep the group drop email)
3. Midpoint hubs (keep AI + manual)
4. Cron (keep "Check fares now"; explain in the writeup that the cron is the next step)

Never cut: private budgets, live join, search job + ranking, caps, lock + booking links.

## When Claude Code goes wrong (watch for these)

- Calls data hooks in top-level pages (outside the `(app)` provider): blank page.
- Uses `useQuery('users')`, which can leak emails. Use `useUsers()` / `useUserLookup()`.
- Takes `tripId` from params and writes without loading the trip and checking membership.
- Calls SerpApi from the browser or in a test loop. Flips billing to `user`/`anonymous` to "fix" a 401.
- Suggests `npx deepspace push`. **Refuse: you're on GitHub source.**
- Says "this works" without running anything. Ask for the command output.
