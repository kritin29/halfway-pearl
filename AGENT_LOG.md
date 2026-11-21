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
