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

## What the agent did
- **Claude (chat)** researched DeepSpace with me, wrote `SPEC.md`, `CLAUDE.md` and `PROMPTS.md`, and reviewed each phase's output.
- **Claude Code** implemented phases 1–8 and demo mode, logging each phase in `AGENT_LOG.md` (what it did, what broke, open questions). Before writing code, it checked the spec against the installed SDK and docs and recorded conflicts in `NOTES.md`. Examples:
  - `userBound` on `travelers.userId` would have stamped the organizer's id on ghost rows (C1).
  - Permission blocks without an `admin` role would have locked the app owner out of their own trips (C2).
  - The scaffold's integration proxy let any signed-in user call SerpApi or `email/send` directly, which would have made the app an owner-billed spam relay; it now returns 403 (C4).
  - `email/send` ignores `from` and costs $0.013 per email, so email caps were added (C5).
  - The planned 600-token AI budget was used up by Haiku's reasoning before any output (Q1).
  - Most recently: the cron's run history, not `deepspace logs`, is the proof a scheduled run happened (D1).

## What I verified or changed myself
- _(to fill in)_
- _(to fill in)_
- _(to fill in)_

## Unfinished / next
- Re-run the one approved SerpApi call when the quota returns and reconcile `flights.ts` with a real response.
- The cron has run once in production (Nov 23, success). No watched trip can get new prices until the quota is back, so the drop and under-budget emails have only been tested with mocks.
- Concurrency (joins, the 6-destination limit, email claims, job retries) is tested with fakes, not under load on real Durable Objects.
- Return-leg times aren't fetched (outbound only); real email delivery to an inbox is unconfirmed; phone layouts were checked in headless Chromium only.
- Next: hotels per destination, ±1-day flexible dates, a "nudge the unbooked" reminder, and leave/delete trip.
