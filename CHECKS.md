# My verification checklist

Do these yourself (not Claude Code). After each one, add a line to `AGENT_LOG.md` under
"I verified myself (how)". These lines are the evidence for the writeup and the live interview.

## Reminders
- [ ] **Report the SerpApi quota problem to DeepSpace** (portal or dashboard.deep.space support):
  "serpapi/flights returns 'SerpAPI error 429: Your account has run out of searches' (billing released). Is the platform quota being topped up?"
- [ ] **Retry the one real flight call** when the quota is back (ask Claude Code to make the approved single call and check `flights.ts` against it).

## Phase 2: logic modules
- [ ] **Airports:** open `src/data/airports.json` and check 5 codes (ORD = Chicago, BNA = Nashville, LHR = London, plus 2 you know). Are the city names and countries right?
- [ ] **Ranking (do this before Phase 5):** read `src/lib/ranking.ts`. Explain out loud, in one sentence each:
  - what "Fairest" sorts by (the lowest *worst* individual fare, so it protects the person paying most)
  - why the "fits everyone's budget" badge hides until 3 people set budgets (with 2, "doesn't fit" would reveal an upper bound on the other person's budget)
- [ ] **Break a test yourself:** in any `src/lib/*.test.ts`, change one expected number, then run `npx deepspace test run unit`. Watch it fail, then undo.
- [ ] **Booking link:** open this and confirm Google Flights shows Midway → Nashville, Dec 11–13:
  https://www.google.com/travel/flights?q=Flights%20to%20BNA%20from%20MDW%20on%202026-12-11%20through%202026-12-13

## Phase 3a: security and data
- [ ] **Read the two key schemas** against SPEC §5:
  - `src/schemas/budgets-schema.ts`: member and admin both `read: 'own'`
  - `src/schemas/usage-schema.ts`: every role all `false`
- [ ] **Prove the paid-integration block works:** in `src/integrations.ts`, temporarily remove `serverOnly: true` from `serpapi`, run `npx deepspace test run`, and watch the 403 api test fail. Restore it.
- [ ] **Prove budget privacy is tested:** in `src/schemas/budgets-schema.ts`, temporarily change member `read: 'own'` to `read: true`, run `npx deepspace test run unit`, and watch `schemas.test.ts` fail. Restore it.

## Phase 3b: on the live site after deploy
- [ ] **Two-browser test:** normal window = you, incognito window = a second account (test account Bob, or your phone). Create a trip, join it with the other account, and change your airports. Does it update live on the other screen?
- [ ] **Budget really private:** in the second account's window, open devtools Console, run `localStorage.DEEPSPACE_DEBUG='1'`, reload, then set a budget like `437` in *your* window. In the second window's Network → WS messages, search for `437`. It must not appear. (Seeing the word `maxUsd` alone is fine; that's the column-name list, not the value.)
- [ ] **Try to break in:**
  - open `/join/wrongcode123`: should show "wrong code"
  - open a trip URL from an account that isn't a member: should say not found
  - join a trip that's full (8 travelers) or locked: should explain why
- [ ] **On your phone:** create form, airport autocomplete, copy invite link (if copying is blocked, the link should still be selectable).
- [ ] **Test shortcuts are off in production:** Claude Code's live check shows `__testLockTrip` → not_found. Read its output yourself.

## Later phases
(added as we go)
