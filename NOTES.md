# NOTES — DeepSpace research vs SPEC.md (Phase 1)

Written 2026-11-20 against `deepspace@0.44.2` (installed) and docs.deep.space as fetched today.
Sources: the `.md` docs listed in CLAUDE.md, `node_modules/deepspace/dist/{schema,worker}.d.ts`,
the bundled runtime `node_modules/deepspace/dist/worker.js` (cited only where the types don't say
what happens), and the scaffold files. `npx deepspace integrations info` (free, no login) was run
for `serpapi/flights`, `anthropic/chat-completion`, `email/send`.

Legend: **[CONFLICT]** the spec says something the docs/types/runtime contradict.
**[GAP]** the spec doesn't say it, and the default would be unsafe or broken. **[DECISION]** needs your call.

---

## 1. Where SPEC.md conflicts with the docs, types, or runtime

### C1 [CONFLICT] `userBound` on `travelers.userId` breaks ghost rows (spec §5 travelers). Details in §6.
Spec: "`userId` | `ownerField`, `userBound` for real users; ghosts written by action".
A column is either userBound or it isn't. The runtime stamps the *acting* user id on every create,
**including RBAC-off server writes**, so a ghost row gets the organizer's id.

### C2 [GAP→CONFLICT] Spec permission blocks leave out `admin`, and the app owner is always admin
Docs (`/concepts/permissions`): *"The app owner is pinned to `admin` at connect time, so you don't promote them manually."*
Runtime `worker.js:612`:
```js
function getRolePermissions(schema, role) {
  if (schema.permissions[role]) return schema.permissions[role];
  if (schema.permissions["*"]) return schema.permissions["*"];
  return { read: false, create: false, update: false, delete: false };
}
```
What this does to the spec as written:
- `budgets`, `travelers`, `votes`, `candidates`, `fares`, `fareSnapshots` define only `member`. **The developer account (owner = admin) gets all-false.** If you demo with your own account, you can't see trips you're in, can't edit your own constraints, and can't set your own budget.
- `trips` has `admin: all true`. The owner's `useQuery('trips')` would then return **every user's trips**, and admin could write trips directly over the socket, skipping the actions.

**Proposal:** on every trip-scoped collection, give `admin` exactly the `member` rules. For `usage`, set all four roles (`'*'`, `viewer`, `member`, `admin`) to false. Server code doesn't need admin; it bypasses RBAC.

### C3 [CONFLICT] JobRoom by default lets every member see every job and enqueue jobs (spec §4, §6 startSearch, §10 "live job progress")
Types (`worker.d.ts:1648-1650`, `JobRoomConfig`):
```ts
/** Re-check whether a connected user may mutate the queue. Defaults to member/admin roles. */
authorizeWrite?: (user: UserAttachment) => boolean | Promise<boolean>;
/** Re-check whether a connected user may observe the queue. Defaults to authorizeWrite. */
authorizeRead?: (user: UserAttachment) => boolean | Promise<boolean>;
```
Docs (`/guides/background-jobs`): *"Paid jobs stay owner-only. If a handler spends owner credits … tighten `authorizeWrite` to `role === 'admin'`."*
The scaffold `worker.ts:72-76` allows member and admin. With that setting, any signed-in user could:
- call `useJobs(SCOPE_ID).enqueue('fare-search', {tripId: <anyone's>, mode:'full'})` and skip every cap check in `startSearch`;
- see every trip's job rows: payload `tripId`, progress messages such as "Checked ORD→BNA", results, errors. The queue is app-wide and can't be split per trip.

**Proposal:** `authorizeWrite` and `authorizeRead` both admin-only (or `() => false`). The client never uses `useJobs`. The job copies its progress into the trip row, which is collaborator-scoped. New `trips` columns: `searchJobId`, `searchProgress` (0..1), `searchMessage`, `searchError`.
Verified in `worker.js:4936` (`onRequest`): the internal `/enqueue` endpoint that `enqueueJob()` calls **does not** run `authorizeWrite`, so tightening it doesn't block server actions or cron.

### C4 [GAP] Any signed-in user can call paid integrations directly from the browser (spec §11, CLAUDE.md "Never call paid integrations from the browser")
`src/server/http-routes.ts:233-262` proxies `/api/integrations/:name/:endpoint`. For a `developer` integration it only requires sign-in, then forwards `APP_OWNER_JWT`. So a signed-in user can `POST /api/integrations/serpapi/flights` in a loop and bypass all `usage` caps. Worse, `POST /api/integrations/email/send` with any `to`/`subject`/`html` turns the app into an **owner-billed spam relay**.
The docs say as much (`/guides/external-apis`): *"auth-gating alone is not spend control … Add your own limit at the app layer."*
**[DECISION] Proposal:** add `serverOnly: true` to `serpapi`, `anthropic` and `email` in `src/integrations.ts`, and have the proxy route return 403 for server-only integrations. Billing mode stays the same; `anonymous` is not touched. This edits a scaffold route, so I want your OK first.

### C5 [CONFLICT] `email/send` ignores `from`, and it costs money the spec doesn't budget for (spec §4 "Sender `<app-slug>@app.space`")
`integrations info email/send` (the installed CLI catalog) says: *"Send a transactional email from DeepSpace Apps <notifications@updates.app.space>. **Any from value is ignored**; use reply_to for replies."* Billing: **$0.013 per request**. Required fields: `to`, `subject`.
The docs page `/guides/external-apis` still says *"Send from `<your-app-name>@app.space`"*. The catalog is the newer, installed source, so it wins.
**Proposal:** don't depend on the sender. Put "Halfway" in the subject and body, send no `reply_to` (we have no inbox), and add email caps to `usage`, for example ≤ 20 emails per trip per day and ≤ 100 globally per day. Constants go in `src/lib/limits.ts`. Lock emails: ≤ 8. Watch emails: one group mail plus ≤ 8 private mails per trip per day.

### C6 [CONFLICT, docs-internal] Do developer-billed integrations allow anonymous callers?
`/guides/server-actions` and `/guides/external-apis` have a table that says `'developer'` → *"Anonymous callers allowed"*. The installed scaffold (`src/integrations.ts` header, migration `2026-10-integrations-sign-in`) says *"Every integration requires a signed-in caller. Set `anonymous: true` … to let signed-out visitors call it too."* The proxy code enforces the scaffold version. The installed code wins, and spec §11 already matches it. No change needed; recorded so nobody "fixes" it from the docs.

### C7 [GAP] Members can trigger owner-billed cron tasks, and cron/job rooms accept any room id
Docs (`/guides/scheduled-jobs`): *"Members and admins can fire owner-billed tasks by default … For admin-only writes, customize the route's role resolver to return a writer role only for admins."*
- `src/server/realtime-routes.ts:158-166` passes the caller's real role to the cron room. So any member can `useCronMonitor(...).trigger('fare-watch')`.
- `/ws/cron/:roomId` and `/ws/jobs/:roomId` accept **any** `roomId` (`realtime-routes.ts:24,41`). Docs: *"CronRoom arms its alarm inside that first fetch."* So `/ws/cron/x1`, `/ws/cron/x2`, … would likely each create a separate CronRoom with the same `fare-watch` task, which multiplies daily runs. *(I did not run this; it follows from the code and docs.)*

**Proposal:** in `realtime-routes.ts`, (a) return 404 unless `roomId === \`app:${env.DEEPSPACE_APP_ID}\`` for cron and jobs; (b) the cron role resolver returns `'admin'` only for admins, `'viewer'` for everyone else. Either way, the global `usage` caps limit the worst case, and the per-trip "watched today" marker keeps it idempotent.

### C8 [CONFLICT] `buildCronContext` is weaker than spec §8 assumes
Spec §8 suggests `buildCronContext(env, env.OWNER_USER_ID, app scope)` for jobs. The type exists (`worker.d.ts:3672-3712`), but:
- `records.query(collection, { where?, limit? })` has **no orderBy**, and there is **no `get`**, no `deleteWhere`, and **no upsert-by-recordId** on create (`create(collection, data)`).
- It throws on failure instead of returning `{success,…}`. `integrations.call` also throws (`worker.js:8122+`).
- `roomId` **defaults to `"default"`** (`worker.js:8122`: `function buildCronContext(env, ownerUserId, roomId = "default")`). Forgetting the third argument quietly writes to a different, empty room.

**Proposal:** see §2. Use one shared tools factory for actions, jobs and cron.

### C9 [minor] Spec §9 "open the app once after each deploy"
Docs: the scaffold's `armCronRoom` middleware (`worker.ts:130-133`) plus deploy's own `GET /api/auth/ok` wake-up arm the schedule automatically. Opening the app is unnecessary but harmless. The real check is `deepspace logs --search cron` → `[cron] fare-watch ok`.

### C10 [spend trap] `anthropic/chat-completion` defaults to `claude-opus-5-5` with `max_tokens: 4096`
From `integrations info`. `suggestCandidates` must pass `model` explicitly; the catalog says standard pricing applies to `claude-haiku-5-5`. It should also use a small `max_tokens` (~600) and a JSON-only system prompt.

### C11 [GAP, privacy] `useUsers()` shows every registered user's name to every signed-in user
Docs (`/concepts/permissions`): *"Non-admins get the public-identity projection of every registered user … `roster: 'read-policy'` scopes the directory to the rows the caller's `read` rule grants."* The scaffold users schema uses the default, so all members can see the names and avatars of users in other trips.
**Proposal:** set `roster: 'read-policy'` on `usersSchema`. Show names from `travelers.displayName`, which an action copies from the caller's `users.name` on create/join. The users `read` stays `'own'`.

### C12 [CONFLICT with CLAUDE.md testing rule] `page.route` can't mock the fare search
CLAUDE.md says: *"Mock only the external integration boundary (use the saved SerpApi fixture)."* The docs' mocking tool is Playwright `page.route(...)`, which only intercepts **browser** requests. Fare search calls SerpApi from the **JobRoom inside the worker** (worker → api-worker). Playwright never sees that request.
**[DECISION] Proposal:** put a narrow seam at the integration call. `src/server/flights-source.ts` exports `searchFlights(tools, env, params, tripName)`. It returns the saved fixture **only when** `env.ALLOW_DEBUG_ROUTES === 'true'` (docs: set by `deepspace dev start` / `test run`, *"never in production"*) **and** the trip name starts with `__test-`. Every other case makes the real `tools.integration('serpapi/flights', …)`. Parsing, ranking, caps and record writes still run for real.

### C13 [notes, not conflicts]
- **Jobs run one at a time per JobRoom** (docs: *"Jobs still run one at a time"*). There is one queue for the whole app, so two trips' searches run back to back. At ≤ 30 calls × 4 concurrent that's about a minute per job. Fine at our scale.
- **Retries re-run the whole handler** (docs: *"Write handlers so a retry does not duplicate completed side effects"*). With `maxAttempts: 2`: the < 6h fare cache makes a retry cheap, the usage counter still counts every real call, emails are deduped by markers, and on the final failure the job sets `trips.status` back from `searching` (`job.attempts >= job.maxAttempts`).
- **`where` is equality-only on primitives** (actions docs). We can't query "memberIds contains X", ranges, or `IN`. Cron queries `watchEnabled: 1` and filters status/date in code. Server code always scopes queries with `where: { tripId }`.
- **`tools.query` with no `limit` is unbounded** (`worker.js:2729+`). The client `useQuery` / AI tools default to 50 (`DEFAULT_QUERY_LIMIT = 50`). Client `useQuery` calls should pass `where: { tripId }` and an explicit `limit`.
- **`hasBudget` is set by the client, so it can be faked.** Use it only for the "budget set ✓" chip. The ≥ 3-budgets privacy rule (§7) must count actual `budgets` rows server-side, and only for userIds that are real travelers on the trip.
- **`budgets` has no membership check**, so a user can create a budget row with any `tripId`. That's harmless because only they can read it. The job reads budgets with `where: { tripId }` and ignores userIds that aren't travelers.
- **Column types:** dates are `storage:'text', interpretation:{kind:'date'}` (ISO `YYYY-MM-DD`). Datetimes are text ISO. `memberIds`/`homeAirports`/`missingFor` are `{kind:'json'}`, which arrive parsed in actions and on the client. Booleans are `storage:'number'` with 0/1.
- **SerpApi output has no schema in the catalog** (`integrations info serpapi/flights` prints only the input schema: `departure_id, arrival_id, outbound_date, return_date, type (string), adults (number), currency, hl`). Spec §7 input fields match. To build the fixture we need **one real call ($0.0325)**, which I'll only make with your go-ahead.
- **AI agent tool routes** (`/_deepspace/agent/tools/:name`, from `registerAgent` in `worker.ts`) let any member run `records.query/create/update/delete` **as themselves, with RBAC on** (`createUserToolExecutor`). That's no new privilege, but it's one more client write path, so schema permissions alone must be safe. It's also a handy test probe (§3).

---

## 2. How a JobRoom job calls an integration and reads/writes records

**Identity:** the app owner (`env.OWNER_USER_ID`). Docs (`/guides/background-jobs`): *"Handlers run as the app owner, just like scheduled tasks."* No caller JWT is available inside a job.
**Room id:** `` `app:${env.DEEPSPACE_APP_ID}` `` (the RecordRoom scope; never `APP_NAME`, never the `"default"` that `buildCronContext` falls back to).
**Integration billing:** developer → `APP_OWNER_JWT`. A `'user'`-billed integration **can't** work from a job (no caller JWT). All three of ours are developer-billed.

Relevant signatures:
```ts
// worker.d.ts:1597 / 1615
interface Job<P = unknown> { id; type; status; payload: P; attempts; maxAttempts; enqueuedBy?: string|null; resumeFrom?: unknown; … }
interface JobContext { progress(value: number, message?: string): void; continue(state: unknown, options?: { afterMs?: number }): void; signal: AbortSignal }
// worker.d.ts:3476 (ActionTools — what we'll reuse)
get<T>(collection, recordId): Promise<ActionResult<GetActionData<T>>>
query<T>(collection, { where?, orderBy?, orderDir?, limit? }): Promise<ActionResult<QueryActionData<T>>>
create<T>(collection, data: T, recordId?: string): Promise<ActionResult<MutateActionData>>   // recordId ⇒ upsert/merge
update / remove / deleteWhere(collection, where, limit?)
integration<T>(endpoint: string, data?: unknown): Promise<ActionResult<T>>
// worker.d.ts:3712 (fallback option)
declare function buildCronContext(env: CronEnv, ownerUserId: string, roomId?: string): CronContext;
```

**Plan:** move the scaffold's private `createActionTools(env, userId, callerJwt)` (`src/server/action-routes.ts:72-151`) into `src/server/app-tools.ts` as `export function createAppTools(env: Env, actingUserId: string, callerJwt = ''): ActionTools`. Then:
- **actions:** `createAppTools(env, auth.userId, callerJwt)`, the same behaviour as today;
- **job / cron:** `createAppTools(env, env.OWNER_USER_ID)`. Records go through `RECORD_ROOMS.idFromName(\`app:${env.DEEPSPACE_APP_ID}\`)` with `X-User-Id: OWNER_USER_ID`, `X-App-Action: true` (RBAC off). `tools.integration('serpapi/flights', body)` signs with `APP_OWNER_JWT` and returns the `{success,data|error,code}` envelope instead of throwing.

That gives jobs `get`, `orderBy`, upsert-by-id (for the `usage` ledger) and `deleteWhere`, and one code path to test. `runJob(job, ctx, env: Env)` dispatches `job.type === 'fare-search'`, forwards `ctx.signal`, and calls `ctx.progress()` plus a throttled `tools.update('trips', tripId, { searchProgress, searchMessage })` (C3).

**What follows from the owner identity:** rows the job creates get `createdBy = OWNER_USER_ID`, and any `userBound` column is stamped with the owner id (see §6). So the job **must never create** `trips`, `travelers`, `budgets` or `votes`. It only writes `fares`, `candidates` (update), `fareSnapshots`, `usage`, and `trips` (update).

**Concurrency caveat:** a `usage` increment is get-then-update, two DO calls, so it isn't atomic. Inside the job, ledger writes go through one serial promise chain even while flight calls run four at a time. Two `startSearch` clicks at the same instant could each slip one past a cap. That's acceptable; caps are soft by ±1.

---

## 3. A collection with all permissions false: unreadable by clients, writable by server code?

**Yes, both.**
- **Clients:** any role not listed falls back to `'*'`, then to all-false (`worker.js:612`, quoted in C2). Reads go through `canRead` → `checkPermissionLevel(false)` → `false` (`worker.js:642-644, 673`). Docs: *"The DO drops records the caller can't read **before** sending them over the WebSocket."* Creates go through `canCreate` → `create === true` → false.
- **Server:** action/job/cron tools send `X-App-Action: true` (`action-routes.ts:87`). The tools endpoint passes that as `skipUserRbac` (`worker.js:2699`: `const isAppAction = …"x-app-action" === "true"`, then `executeTool(…, isAppAction)`). `putRecord` skips the whole `canCreate/canUpdate/checkFieldPermissions` block when `skipUserRbac` is true (`worker.js:1512+`). Docs: *"Bypassing RBAC requires a server action."*
- The `usage` schema sets `'*'`, `viewer`, `member`, `admin` explicitly to `{read:false, create:false, update:false, delete:false}`, so even the owner's browser can't read it (C2). Plus `uniqueOn: ['day','key']`, written with deterministic `recordId = \`${day}|${key}\`` via `tools.create(…, recordId)` (upsert).

**How we'll test it:**
1. **Unit** (`src/schemas/schemas.test.ts`): import `canRead`, `canCreate`, `canUpdate`, `canDelete`, `lintSchemas` from `deepspace/worker` (exported runtime functions). Assert they're all false on `usageSchema` for `'*'|'viewer'|'member'|'admin'` with a sample record, and that `lintSchemas(schemas)` returns no warnings. The same file asserts the budget rules: owner reads, a non-owner member doesn't, admin non-owner doesn't.
2. **API/e2e** (`tests/collab.spec.ts`, `users(2)`): user A calls `createTrip`, which increments `usage` key `trips:user:<A>`. Then A **and** B each call the agent tool route `POST /_deepspace/agent/tools/records_query` with `{collection:'usage'}` (exact tool name confirmed from `GET /_deepspace/agent/tools` when we write it). This executor runs with RBAC on, the same `canRead` as the socket. Expect **zero records**, and `records_create` on `usage` refused. I'd rather not ship a debug page that renders `useQuery('usage')`, so the agent route is the client-side probe.
3. **Server can write it (positive):** a cap test. Hitting the per-trip full-search cap through `startSearch` (in fixture mode, C12) returns `{success:false, code:'cap_reached'}`. That only works if the server read and wrote `usage`.

---

## 4. How `'collaborator'` read works, and whether the owner is included

Runtime (`worker.js:617-633, 653-654`):
```js
function isOwner(schema, record, userId) {
  if (!userId) return false;
  if (schema.ownerField) return record.data[schema.ownerField] === userId;
  return record.createdBy === userId;
}
function isCollaborator(schema, record, userId) {   // collaboratorsField may be a JSON string or an array
  … JSON.parse(collab).includes(userId) … / collab.includes(userId)
}
if (level === "collaborator") return isOwner(schema, record, userId) || isCollaborator(schema, record, userId);
```
Docs (`/concepts/permissions`): *"`'collaborator'` - owner OR in `collaboratorsField` (owners always pass)"*.

**So yes, the owner is included automatically**, and "owner" means `data[ownerField]` when `ownerField` is set, **otherwise `createdBy`**. Per collection:

| collection | ownerField | who passes 'collaborator' besides memberIds |
|---|---|---|
| trips | organizerId | the organizer (we also keep them in memberIds) |
| travelers | userId | that traveler (ghost ids never match a user, so nobody extra) |
| votes | userId | the voter |
| candidates / fares / fareSnapshots | *(none)* | **`createdBy`** = the acting user of the action that created it (organizer/member), or **OWNER_USER_ID** for rows the job created |

The last row has a side effect: a user who created a row keeps read access to it even if they're later dropped from `memberIds`, and the developer (owner) can read job-written rows for every trip. Core scope has no "leave trip", so I'd accept it. If we build "leave trip" (stretch), we can either add `ownerField: 'tripId'` (never equals a user id, so only memberIds count; schema-lint stays quiet because no client role can create) or keep it and document it.

Two more points:
- `collaboratorsField` holds a JSON **array of user ids**. Declare the column `{ kind: 'json' }` and write arrays. Ghost ids are never added.
- **To verify in e2e:** after `joinTrip` updates `memberIds` on existing rows, does B's open `useQuery` receive those rows live without a reload? The docs describe re-evaluation explicitly only for `visibilityField`. The broadcast step says *"to every connected client whose RBAC allows read access"*, evaluated at broadcast time, so it should work. Test: B joins, and B sees the existing candidates without reloading.

---

## 5. Enqueueing a job from a server action

```ts
import { enqueueJob } from 'deepspace/worker'
// worker.d.ts:1743
// declare function enqueueJob(namespace: DurableObjectNamespace, roomId: string, type: string,
//   payload?: unknown, options?: { maxAttempts?: number; enqueuedBy?: string }): Promise<string>;

const jobId = await enqueueJob(
  env.JOB_ROOMS,                       // binding from __DO_MANIFEST__ (worker.ts:44) → Env via DOBindings
  `app:${env.DEEPSPACE_APP_ID}`,       // immutable app id; the docs' example uses this; the .d.ts comment's `app:${env.APP_NAME}` is stale
  'fare-search',
  { tripId, mode: 'full' },
  { maxAttempts: 2, enqueuedBy: userId },
)
```
- It returns the job id or **throws** (`worker.js:5347+`: `enqueueJob failed: <status>`). The action wraps it, sets `trips.searchJobId`, and on throw rolls `status` back and returns `{success:false, code:'enqueue_failed'}`.
- The order inside `startSearch`: load trip → organizer check → `status !== 'searching'` → cap checks in `usage` → increment search counters → `status='searching'` → enqueue.
- From cron it's the same call. Inside `AppJobRoom.onJob`, chained work could use `this.enqueue(...)`, but we don't need it.
- The internal `/enqueue` path ignores `authorizeWrite` (C3), so the locked-down room still accepts server enqueues.

---

## 6. Does `userBound` on `travelers.userId` block ghost rows? Yes. Here's what to do instead.

Runtime `putRecord` (`worker.js:1512-1555`) runs **before** the `if (!skipUserRbac)` block, so it applies to server actions too:
```js
if (!isUpdate) {
  …
  if (col.userBound) { mergedData[col.name] = userId; }          // L1543-1544: always the acting user
} else {
  if (col.immutable && data[col.name] !== void 0 && data[col.name] !== existing.data[col.name])
    return { success: false, error: `Cannot modify immutable field '${col.name}'` };   // L1550-1551
  if (col.userBound && data[col.name] !== void 0) { mergedData[col.name] = existing.data[col.name]; } // L1553-1554
}
```
In an action, `userId` is `X-User-Id` = the caller (`action-routes.ts:86`), and `records.create` passes it straight through (`worker.js` `case "records.create"` → `putRecord(ctx, collection, recordId, data, userId, userRole, skipUserRbac)`). So `addGhost` writing `userId: 'ghost:…'` would **silently store the organizer's id**. That collides with the organizer's own row, and if we use `uniqueOn: ['tripId','userId']` the create is refused as a duplicate.

**Fix (proposed):** on `travelers.userId`, **drop `userBound`** and keep `immutable: true, required: true`. Security still holds because:
- members (and admin, per C2) have `create: false`, so a client can never create a traveler row, real or ghost;
- `writableFields` for update excludes `userId`, `memberIds`, `tripId`, `isGhost`, `displayName`;
- `update: 'own'` compares `data.userId === caller`, so ghost rows (`ghost:<uuid>`) are client-uneditable and only organizer actions touch them;
- schema-lint stays quiet. It only warns when a non-admin role has `create === true` and the ownerField isn't userBound (`worker.js:746-753`).

The actions set `userId` explicitly: `ctx.userId` for real travelers (createTrip/joinTrip), `` `ghost:${crypto.randomUUID()}` `` for ghosts. Add `uniqueOn: ['tripId','userId']` so `joinTrip` stays idempotent under double-clicks.

**Keep `userBound`** where the *caller* is always the subject: `trips.organizerId` (createTrip caller), `votes.userId` (toggleVote caller), and `budgets.userId` (client creates its own). Rule: **the job never creates rows in collections with a userBound column.**

Rejected alternative: a separate `ghosts` collection. It doubles the queries, ranking inputs and UI joins, and it doesn't fix anything the above doesn't.

---

## 7. Proposed file list (whole project)

`M` = modify scaffold, `+` = new. Unit tests sit next to their source (vitest `include: src/**/*.test.ts`).

**Worker / server**
- `M worker.ts`: `AppJobRoom` `authorizeWrite`/`authorizeRead` admin-only; `runJob(job, ctx, this.env)` typed `Env`.
- `M src/server/action-routes.ts`: use `createAppTools`.
- `+ src/server/app-tools.ts`: `createAppTools(env, actingUserId, callerJwt?)` (§2).
- `M src/server/realtime-routes.ts`: pin cron/jobs room ids, admin-only cron writes (C7).
- `M src/server/http-routes.ts`: 403 for `serverOnly` integrations in the browser proxy (C4) **[needs OK]**.
- `M src/integrations.ts`: `serpapi`, `anthropic`, `email` → `{ billing: 'developer', serverOnly: true }`.
- `+ src/server/trip-access.ts`: `loadTrip`, `requireMember`, `requireOrganizer`, `ok()/fail(code)` helpers.
- `+ src/server/trip-rows.ts`: `propagateMemberIds(tools, tripId, memberIds)`, `loadTripBundle`, `readBudgetsForTrip` (server-only; never returned).
- `+ src/server/usage.ts`: ledger get/increment over `usage` (uses `src/lib/caps.ts` for the decisions).
- `+ src/server/flights-source.ts`: real SerpApi call vs. fixture seam (C12).
- `+ src/server/fare-search.ts`: the job pipeline (§8 of spec), calling pure libs.
- `+ src/server/email.ts`: templates + capped `email/send` (lock links, group drop, private under-budget).
- `+ src/server/ai-suggest.ts`: prompt + JSON parse for `suggestCandidates` (explicit haiku model).

**Actions** (`M src/actions/index.ts` re-exports one map)
- `+ src/actions/trips.ts`: createTrip, joinTrip, setWatch, lockTrip.
- `+ src/actions/ghosts.ts`: addGhost, updateGhost, removeGhost.
- `+ src/actions/candidates.ts`: addCandidate, suggestCandidates, addMidpointHubs, removeCandidate.
- `+ src/actions/search.ts`: startSearch, checkFaresNow.
- `+ src/actions/votes.ts`: toggleVote.

**Jobs / cron**
- `M src/jobs.ts`: dispatch `fare-search`.
- `M src/cron.ts`: `fare-watch` task (`0 8 * * *`, `America/Chicago`).

**Schemas** (`M src/schemas.ts` registers all)
- `+ src/schemas/{trips,travelers,budgets,candidates,fares,votes,fare-snapshots,usage}-schema.ts`
- `M src/schemas/users-schema.ts`: `roster: 'read-policy'` (C11).
- `+ src/schemas/schemas.test.ts`: permission matrix + lint (§3).

**Pure libs (Vitest)**
- `+ src/lib/limits.ts`: every cap and cost constant in one place.
- `+ src/lib/types.ts`: row data types shared by client and worker.
- `+ src/lib/validate.ts` (+test): IATA, dates, names, param parsing.
- `+ src/lib/airports.ts` (+test): lookup, centroid, nearest major hubs.
- `+ src/data/airports.json`: IATA, city, country, lat, lon, major flag.
- `+ src/lib/flights.ts` (+test): request builder, merge/filter/select, red-eye rule, booking URL.
- `+ src/lib/__fixtures__/serpapi-flights-<route>.json`: one saved real response **[needs OK for 1 call]**.
- `+ src/lib/ranking.ts` (+test): aggregates, fitsAll privacy guard, three sort orders.
- `+ src/lib/caps.ts` (+test): cap decisions given ledger counts.
- `+ src/lib/watch.ts` (+test): drop detection, threshold-crossing.

**Client**
- `+ src/lib/actions-client.ts`: typed `callAction(name, params)` with `getAuthToken`, returns the envelope.
- `+ src/hooks/useTripData.ts`: `useQuery` wrappers scoped by `tripId` with limits.
- `+ src/hooks/useAction.ts`: pending/error state for action buttons.
- `M src/pages/index.tsx`: static landing (pitch, 3 steps, "Start a trip").
- `+ src/pages/(app)/(protected)/trips.tsx`: my trips + create form.
- `+ src/pages/(app)/(protected)/join/[code].tsx`
- `+ src/pages/(app)/(protected)/t/[tripId].tsx`: tab shell.
- `+ src/components/trip/{CrewTab,YourSettings,PrivateBudget,GhostDialog,InviteLink,DestinationsTab,SearchProgress,ResultsTab,ResultCard,VoteButton,BookTab,FareSparkline}.tsx`
- `+ src/components/AsyncState.tsx`: loading / empty / error-with-retry wrapper.
- `M src/nav.ts`, `M src/components/Navigation.tsx`: Trips nav; drop scaffold items later.
- scaffold `home.tsx`, `api-status.tsx`, `settings.tsx`: keep until the UI phase, then remove with their tests.

**Tests**
- `M tests/smoke.spec.ts`: landing static contract, `/trips` gated, route coverage.
- `M tests/api.spec.ts`: every action → 401 without token; 403/not-found for a non-member trip id; integration proxy 403 for server-only (C4).
- `M tests/collab.spec.ts`: two users: create/join, live constraint updates, **B can't read A's budget** (useQuery + agent route), **non-member sees no trip**, `usage` unreadable, B sees existing candidates after join without a reload, lock → Book checklist live.

**Docs / process**
- `+ NOTES.md` (this file), `M SPEC.md` (after you approve the changes below), `M AGENT_LOG.md` per phase.

---

## Decisions I need from you before Phase 1
1. **C4:** add `serverOnly` and block paid integrations in the browser proxy (edits a scaffold route)?
2. **C12:** the fixture seam gated on `ALLOW_DEBUG_ROUTES === 'true'` + a `__test-` trip name, for e2e fare search?
3. **C3:** lock the JobRoom down to admin-only and copy progress onto the `trips` row (adds 4 columns)?
4. **C2 / C6 / C11 / §6:** update SPEC.md with: admin = member rules, `usage` all-false incl. admin, no `userBound` on `travelers.userId`, `roster: 'read-policy'`, email sender/caps.
5. **One real `serpapi/flights` call ($0.0325)** to save the fixture, and which route (e.g. `ORD,MDW → BNA`).

---

## Resolution (2026-11-20)
The developer approved all five decisions: C4 serverOnly + 403 with api tests; the C12 seam with a real-path unit test; C3 JobRoom admin-only + trip-row progress; the SPEC updates, plus C7 and the `createAppTools` refactor, with the createdBy/leave-trip side effect recorded as a known limitation; and one real `serpapi/flights` call deferred to Phase 2 (ORD,MDW → BNA, 2026-12-11 → 2026-12-13). SPEC.md is updated and its Changelog maps each change back to the items above.
