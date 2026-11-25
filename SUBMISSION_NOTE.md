# Submission note: Halfway

**Live:** https://halfway-pearl.app.space · **Repo:** https://github.com/kritin29/halfway-pearl

## What I built
Halfway helps friends in different cities pick where to meet. Each person joins a shared trip from their own phone and enters their own home airports, flight rules (max stops, no red-eyes, earliest departure) and an optional **private budget** nobody else sees. A background job prices every traveler to every candidate city. Destinations are ranked three ways: **Cheapest** (group total), **Fairest** (lowest worst-off fare) and **Together** (smallest arrival spread). The group votes, the organizer locks one, everyone gets their own booking link and a live "who's booked" checklist, and a **daily fare watch** emails when the trip gets cheaper.

MeetPoint and Kayak Rendezvous already answer "which city is cheapest for these origins?", but as single-player calculators: one person types everyone's cities and pastes a screenshot into the group chat. Group trips fail on coordination, not search: nobody wants to say their budget out loud, one person chases everyone's airports, prices move, and half the group never books. Halfway is that coordination layer.

## DeepSpace pieces
- **Integrations** (all `developer`-billed, sign-in required, and `serverOnly`, so the browser proxy returns 403 and calls only happen in actions/jobs/cron after cap checks): `serpapi/flights` (fares plus Google's low/typical/high price insight), `anthropic/chat-completion` (destination ideas from a "vibe", always Haiku, parsed defensively, airports validated against a bundled list), `email/send` (booking links, drop and under-budget alerts, deduplicated through an `emailLog` claim).
- **Platform:**
  - One RecordRoom for the app. Every trip row carries `memberIds` as its `collaboratorsField` with `read: 'collaborator'`, so the room only sends a row to people on that trip.
  - `budgets` is `read: 'own'`; `usage`, `fareCache` and `emailLog` are server-only.
  - Server actions do every trusted write, each checking membership or organizer itself (RBAC is off inside actions).
  - A JobRoom job runs the parallel fare search; it's admin-only, and progress is copied onto the trip row.
  - A CronRoom task runs the 08:00 Chicago fare watch, pinned to the app room, with writes for admins only.
- **Left out on purpose:** weather (forecasts don't reach trip dates, so it would mislead), hotels (would double search spend; next step), maps (decoration; airports and arrival times carry the decision), image generation, voice, canvas, payments, AI chat (no user value in this flow).

## Main tradeoff
**Privacy vs. transparency in "Fits everyone's budget."** The server computes whether a destination fits every budget, but hides the badge until **at least 3 travelers** have set budgets (counted from real `budgets` rows server-side, not the client-set `hasBudget` flag). With two people, "doesn't fit" would tell you something about the other person's budget. Each person still privately sees "your fare vs your budget", and alert emails never contain a budget. The cost is that small groups don't get the group-level badge.
Briefly, two others:
- One app-wide room with denormalized `memberIds`, rather than a room per trip. It's simpler for actions, jobs and the cron, but `memberIds` must be copied to every row on join.
- Hard spend caps (30 calls per run, 80/day app-wide, 2 searches and 3 watch checks per trip per day, a 6 h route cache) over completeness: a capped run marks unchecked routes rather than spending more.

## The SerpApi outage and demo mode
The platform's shared SerpApi account has been out of searches for the whole build. All three real `serpapi/flights` calls (Nov 20, 21 and 23) returned `429 "Your account has run out of searches."` with billing released. So **no real flight response has been seen**, and `flights.ts` is built against SerpApi's published format and a hand-made fixture. Real trips show a plain-language outage banner. A search the outage stopped before fetching or being billed for anything is given back to the daily limit, and the rest of the app still works.
**Demo mode** exists only so reviewers can see the full flow. "Try a demo trip" creates a trip with two ghost travelers, four destinations and sample fares from that fixture. Every demo screen and card says "Demo trip: sample prices, not live fares." Demo trips never call SerpApi or send email, aren't watched by the cron, can be created only by the server (3 per user per day), and their prices are cached per trip so they can't reach a real trip. Demo prices are illustrative, not observed.

I reported the outage to DeepSpace on Nov 21 and followed up on Nov 23; they confirmed the provider issue is on their side and said they'll take it into account in review.

## What the agent did
- **Claude (chat)** researched DeepSpace with me, wrote the plan (`SPEC.md`, `CLAUDE.md`,
  `PROMPTS.md`), drafted each phase's prompt and reviewed each phase's output with me.
- **Claude Code** built everything in phases (logged in `AGENT_LOG.md`): data model and
  permissions, actions, the fare-search job, results, lock/book/emails, the fare watch, polish,
  demo mode, two visual passes, a whole-app bug review and delete-trip. Before writing code it
  checked the spec against the installed SDK and recorded conflicts in `NOTES.md`. Examples:
  - `userBound` would have stamped the organizer's id on ghost travelers (C1).
  - Permissions without an `admin` role would have locked the app owner out (C2).
  - The scaffold's integration proxy let any signed-in user call SerpApi or `email/send` on
    my bill (C4). Its final review found the block could still be bypassed by letter case
    (`SerpApi/flights`), and replaced it with an allowlist (E1).
  - The 600-token AI budget was used up by Haiku's reasoning before any output (Q1).
  - The cron's run history, not `deepspace logs`, proves a scheduled run happened (D1).
- It also caught its own mistakes: a permission test that passed even when broken, and an
  earlier claim that cron errors were already free of user data (they weren't; fixed and
  tested).

## What I verified or changed myself
- **Checked the agent's claims in the SDK:** read `worker.js` lines 1543–1545 to confirm that
  a `userBound` column is overwritten with the acting user's id (why ghosts can't use it);
  ran `integrations info` to confirm `email/send` ignores `from` and costs $0.013, and that the
  AI endpoint defaults to Opus.
- **Budget privacy by hand:** two accounts on one trip; set my budget to 8361 and searched the
  other account's WebSocket messages for it: no match.
- **Tests catch real bugs:** broke an expected value in `ranking.test.ts` and changed the
  budgets read rule to `true`; tests failed both times; restored (`git status` clean).
- **On the live site:** live sync between two browsers; the demo trip end to end (results,
  sort tabs, labels, lock with emails off); a real trip showing the outage banner without
  breaking anything.
- **Cron:** read the production run history myself with `scripts/live-check/cron-history.mjs`
  (fare-watch succeeded Nov 23 and Nov 24).
- **Found while testing and had fixed:** sign-in looked like it had no sign-up (DeepSpace only
  allows Google/GitHub sign-up, so I changed the wording); empty scroll at the bottom of the
  demo page; added organizer delete-trip, and chose to leave out leave-trip because it needs
  a data-model change on live data the day of the deadline.
- **Directed the work:** reviewed and sent every phase's rulings, rejected a generic-looking
  redesign, reported the SerpApi outage to DeepSpace, and froze the code to document E9–E14
  instead of rushing fixes.

## Unfinished / next
- Re-run the one approved SerpApi call when the quota returns and reconcile `flights.ts` with a real response.
- The cron has run once in production (Nov 23, success). No watched trip can get new prices until the quota is back, so the drop and under-budget emails have only been tested with mocks.
- Concurrency (joins, the 6-destination limit, email claims, job retries) is tested with fakes, not under load on real Durable Objects.
- Return-leg times aren't fetched (outbound only); real email delivery to an inbox is unconfirmed; phone layouts were checked in headless Chromium only.
- Six open issues from the final review are documented with fixes (README "Known limitations", NOTES E9–E14). The main ones: a re-search during a provider outage can wipe earlier results, and removing a traveler can trigger a false price-drop email. Smaller ones: limits can be passed by clicking from several tabs at once, and a lock racing a new search from two tabs can undo the lock.
- Next: leave trip (members), hotels per destination, ±1-day flexible dates, and a "nudge the unbooked" reminder.
