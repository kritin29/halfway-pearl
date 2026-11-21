# Submission note (draft — fill from AGENT_LOG.md, keep it to ~1 page)

**Live:** https://<slug>.app.space
**Repo:** https://github.com/<you>/<repo>

## What I built
Halfway helps friends in different cities pick where to meet. Each person joins a shared trip from their own device and enters their home airports, travel constraints, and an optional **private budget** that nobody else can see. Halfway searches flights for every traveler to every candidate city in a background job, ranks destinations by cheapest total, fairest (lowest worst-case fare), and arrival alignment, marks whether each price is low or high for the route, lets the group vote and lock a winner with per-person booking links, and runs a daily **group fare watch** that emails when the trip gets cheaper.

Existing tools (MeetPoint, Kayak Rendezvous) are single-player calculators. I focused on the coordination problems they don't solve: private budgets, self-entered constraints, prices changing over time, and getting everyone to book.

## DeepSpace pieces I used
- **Integrations:** `serpapi/flights` (fares + Google price insights), `anthropic/chat-completion` (destination ideas from a "vibe", validated against an airport list), `email/send` (booking links, fare-drop alerts).
- **Platform:** auth; RecordRoom collections with RBAC (`read: 'own'` for budgets, `collaboratorsField` + `'collaborator'` for trip rows); server actions for every trusted write; a JobRoom job for the parallel search with live progress; a CronRoom task for the daily watch.
- **Left out on purpose:** weather (forecasts don't reach trip dates, so it would mislead), hotels (time; next step), voice/canvas/payments (no user value here).

## Main tradeoff
<e.g. Privacy vs. transparency: the server computes "fits everyone's budget" but hides the badge until at least 3 people have set budgets, because with 2 people a "doesn't fit" would reveal an upper bound on the other person's budget. Each person still sees their own fit privately.>
<Alternative candidates: one app room with denormalized memberIds vs. a room per trip; spend caps vs. completeness of search.>

## What the agent did
<From AGENT_LOG: planning research + spec drafted with Claude; implementation phases with Claude Code: …>

## What I verified or changed myself
<Concrete: two-browser privacy check via WebSocket frames; compared fares with Google Flights; rewrote the suggestion prompt; fixed X; tightened caps after checking per-call price; …>

## Unfinished / next
<Honest list.>
