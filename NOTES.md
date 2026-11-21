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

---

## Phase 3a findings (2026-11-21)
No conflicts with SPEC.md. Gaps found while building, for later phases:
- **G1 Client-written traveler constraints aren't validated by the room.** `writableFields` limits *which* columns a client writes, not their values: a member can store 20 bogus `homeAirports` or `maxStops: 99` on their own row. The fare-search job (Phase 5) must re-validate with `src/lib/validate.ts` (`homeAirports`, `maxStops`, `departHour`) and skip or clamp bad rows.
- **G2 `budgets.maxUsd` > 0 isn't enforced** (client-written too). Server code reading budgets must ignore non-positive / non-finite values, as well as userIds that aren't travelers (SPEC §5).
- **G3 Confirmed in the runtime:** `records.create` accepts any `recordId` string (no validation), so `usage` ids like `2026-11-20|serpapi:global` are fine (Phase 2 open question). `uniqueOn` violations come back as `success:false, error:"Duplicate: …"` with no code; `tools.get` on a missing row returns `error: "Record not found"` (`RECORD_NOT_FOUND`). `maxLength` exists in 0.44.2 (`ColumnDefinition.maxLength`, enforced in `putRecord`).
- **G4 `resolveAppRole` returns `viewer` for a signed-in user with no `users` row** (they've never opened a page that connects the records socket). Harmless for our gates (admin-only), but tests that need a `member` must open `/home` first.
- **G5 JobRoom sends non-readers an empty snapshot** (`canRead ? jobs : []`, `worker.js` `onConnect`), so the admin-only `authorizeRead` leaks nothing even though the socket opens.

## Phase 3b findings (2026-11-21)
- **P1 [DECISION, not yet in SPEC] `previewInvite({inviteCode})` action.** `/join/:code` must show the trip name, but a non-member can't read the trip row. The action returns name, dates, traveler count, `locked`, `full`, `alreadyMember`, and the trip id only to someone already on it. Anyone holding the code learns the name and dates, which the code was meant to share anyway.
- **P2 [DECISION, not yet in SPEC] Test-only seam.** `__testLockTrip` (lock a `__test-` trip; the real `lockTrip` sends emails and comes later) and the creation-cap exemption for `__test-` trips both require `ALLOW_DEBUG_ROUTES === 'true'` **and** a `__test-` name (`src/server/test-seam.ts`), the same double gate as the approved fare-fixture seam (C12). Unit tests show both are inert without the flag. Why the exemption: local test data persists in `.wrangler/state`, so a real 10/day cap would lock the pool accounts out after a few e2e runs.
- **P3 The room's `records.list_schemas` message sends every collection's column names** (including `budgets.maxUsd`) to every client. Metadata only, no values, but don't name a column after something secret.
- **P4 Client `where` matching** (`recordMatchesWhere` in `deepspace/dist/index.js`) supports `recordId` and `createdBy`, so `useQuery('trips', { where: { recordId } })` stays live.
- **P5 Agent tool route body is `{ "input": { … } }`** (`POST /_deepspace/agent/browser/tools/records_query`), answered as `{ ok, result: { success, data: { records } } }`; a refused write is HTTP 422 with `CREATE DENIED: role=member, collection=usage`.

## Phase 4 findings (2026-11-21)
- **Q1 [CONFLICT, resolved] `max_tokens` ≈ 600 is too small for Haiku 5.5 (SPEC §4/§6, C10).** Haiku 5.5 runs adaptive thinking by default, and `anthropic/chat-completion` accepts only `model`, `max_tokens`, `messages`, `system`, `temperature` (`integrations info`), so thinking can't be turned off through it. The first real call failed: *"The entire completion budget (max_tokens: 600) was consumed by reasoning tokens before any visible output was produced."* The developer chose 2048. The second real call used 974 output tokens (542 reasoning), $0.00053. A failed call like the first counts against the user's 5/day AI cap (`ai_error`, as it may be billed).
- **Q2 Response envelope (observed, not guessed).** `tools.integration('anthropic/chat-completion', …)` → `{ success: true, data }`, where `data` is an Anthropic Messages object: `content` = `[{type:'thinking', thinking:'', signature}, {type:'text', text}]`, `stop_reason`, `usage` (incl. `output_tokens_details.thinking_tokens`) plus the platform's `costUsd` and `usage.totalTokens`. The thinking text comes back empty. `extractResponseText` reads only the `text` blocks. A provider error arrives as `success:false` with the provider's sentence in `error`.
- **Q3 [DECISION, in SPEC #28] Dev/test-only seams.** `__test-` trips skip the AI cap, and `suggestCandidates` returns `debug: { prompt, raw }`, both only when `ALLOW_DEBUG_ROUTES === 'true'` (unit-tested both ways). Without the exemption, the one real call in `api.spec.ts` (which `test run` and `test run e2e` both include) would lock the pool account out after 5 local runs.
- **Q4 `temperature` is never sent.** The endpoint lists it, but current Anthropic models reject non-default sampling values; we don't need it.
- **Q5 The model's `city`/`country` are ignored;** they come from airports.json. The model's `why` is cleaned (control/bidi chars) and cut to 140 chars. The vibe goes into the prompt JSON-quoted, and the system prompt says trip details are data, not instructions. Output is validated either way.


## Phase 5 findings (2026-11-21)
- **R1 [DECISION, in SPEC #31] The 6h cache needs its own collection.** SPEC §8.4 says "reuse a fare fetched < 6h ago for the same key", but a `fares` row holds one traveler's *chosen* fare after their constraints. Reusing it would ignore a constraint changed since (e.g. switching to nonstop). New server-only `fareCache` (all roles all-false, like `usage`) stores the parsed route options per key; each traveler's current constraints are applied on every run. `flights.ts` `parseFlights` was split into `extractFlightOptions` + `chooseFare` for this (same behaviour, existing tests unchanged).
- **R2 A dead job would leave a trip 'searching' forever.** JobRoom marks a job whose isolate died as failed after 16 min (`RUNNING_STALE_MS`, `recoverStuckRunning`) *without* calling our handler, so our final-attempt cleanup never runs and the destination list stays frozen. `startSearch` therefore treats 'searching' with no trip-row write for 20 min (`LIMITS.staleSearchMs`) as stuck and allows a new search; the old job, if it ever wakes, sees a different `searchJobId` and skips.
- **R3 [DECISION, in SPEC #33] Dev/test budget exemption.** Under `ALLOW_DEBUG_ROUTES === 'true'`, `__test-` trips skip the 3-trips-per-user and the global budget in `startSearch` (fixture answers spend nothing, and local test data persists across runs, NOTES P2). The 2-full-searches-per-trip cap still applies, which the e2e proves. Fixture answers don't touch the `usage` ledger; the per-run call cap still applies.
- **R4 Provider-unavailable and the per-trip count.** A search that fails with provider_unavailable still used one of the trip's 2 daily full searches (counted in `startSearch` before the job runs). The banner text no longer claims otherwise (developer wording). Refunding it would need the job to decrement the ledger; not done.
- **R5 `searchJobId` can be empty when the job starts.** `startSearch` stores it after `enqueueJob` returns, and the job can start first. The job only skips as "superseded" when an id is set and differs.
- **R6 Workers and failure.** With 4 calls in flight, a thrown storage error in one would leave the other three writing rows after the job had failed. Each worker now catches, sets a shared stop flag, and the run rethrows only after all workers settle.
- **R7 Still unverified against a real SerpApi response** (SPEC §7 asked for a re-check "before Phase 5 ships"). The quota is still out and this phase allowed no real calls, so `flights.ts` and the fixture follow SerpApi's published format only. First real search in production is the first real check.
- **R8 Live fill-in.** Candidate aggregates (totals, ranking) land when the run finishes; per-person fare rows arrive live. During a first search the Results tab shows the cards with fares filling in and "The total and ranking appear when the search finishes".

## Phase 6 findings (2026-11-21)
- **S1 [DECISION, in SPEC #38] Email dedupe needs its own server-only collection.** `usage` markers are day-bucketed, so a retry tomorrow would resend; a flag on the `travelers` row would be visible to every member. New `emailLog` (all roles all-false, like `usage`) holds one row per (kind, trip, destination, recipient) key, with no address. The row is created as a **claim before the send**: `uniqueOn ['key']` with a random recordId makes a second create fail with "Duplicate", so two lock calls at once can't both email someone (unit-tested). Success marks it `sent`; a failed send deletes the claim so the retry tries again; a `sending` claim older than 10 min is treated as abandoned (the worker died between send and mark). In that last case one person could get a second email; the alternative is never emailing them.
- **S2 [DECISION, in SPEC #39] Email seam, same double gate as C12.** Playwright can't intercept worker-side `email/send`. In dev/test, `__test-` trips build and validate every message but don't send (`mocked: true`, not counted in `usage`). `__test-real-email-` trips send for real in dev/test; only the one api test uses that. Production: every send is real (the flag is never set there). Unit-tested both ways.
- **S3 The one real `email/send` call succeeded** (`sent: 1, failed: 0, mocked: false`, api test). Pool test accounts have `@deepspace.test` addresses, a reserved TLD, so "success" means the platform accepted the message; delivery can't be checked from here.
- **S4 Counting.** A real send counts against the per-trip (20/day) and global (100/day) email caps. A failed send counts too unless the envelope says `billing: "released"`, the same rule as a SerpApi `error`. Caps are checked per email; capped and failed emails are reported back and go out on a later retry (e.g. tomorrow).
- **S5 Retry path.** `lockTrip` on an already-locked trip with the **same** destination sends only what's missing; the Book tab's organizer button "Email booking links again" does exactly that. A different destination is `trip_locked`. There is no unlock.
- **S6 Two locks with different destinations at once** (only possible with two organizer tabs): each call re-reads the trip after writing and stops if `lockedIata` isn't its own, so normally only the winner emails. If the first call re-reads before the second writes, both send. Accepted (organizer-only, one button, confirm dialog).
- **S7 Default tab.** A member who hasn't clicked a tab moves to Book when the trip locks (the default tab follows status); someone who picked a tab stays on it. Seen in e2e: Bob's page moved to Book live.
- **S8 [RESOLVED in Phase 7, SPEC #42]** Outages that cost nothing are now refunded: a run that ends `provider_unavailable` with zero successful real calls (and no billed failed call) gives the trip's daily full search back; partial outages still count. Original note:
  **[CHECK] Phase 5 ruling wording on provider outages.** The ruling reads "outages not counting toward the daily searches". What was built (and described as decision 4 / NOTES R4) is the opposite: `startSearch` counts the search before the job runs, so a run that hits `provider_unavailable` still uses one of the trip's 2 daily searches. Not changed in this phase. If you want outages refunded, the job would decrement `search:full:trip:<id>` when a run ends with provider_unavailable and no fares; a small change.
- **S9 `updateGhost` already accepted `booked`**, so the organizer ticks ghosts through it; no new action needed. Members tick their own row directly (`booked` is in travelers `writableFields`, `update: 'own'`).

## Phase 7 findings (2026-11-21)
- **W0 Refund rule (S8).** `refundsDailyCount` (src/lib/caps.ts): refund only when the run hit `provider_unavailable` AND made 0 successful real calls AND 0 billed failed calls. I read "zero successful real calls" together with your reason ("billing was released, so it cost nothing"): an outage that follows a generic `error` (which we count as billed) is not refunded. Cache hits and fixture answers aren't real calls, so a run whose only answers came from the cache is refunded too. The refund lands on the day the search was counted (`countedOn` in the payload; startSearch/checkFaresNow/cron set it), never below 0. The same rule refunds a watch run's watch check (not asked for; same reasoning). The per-user "trips searched today" counters and the cron's once-a-day marker are not refunded.
- **W1 [DECISION] Unanswered pairs in watch mode keep their previous fare.** Full mode marks them `error` so cards list who's missing. Doing that in a watch run would wipe a locked trip's booking fares (Book tab "your fare") whenever the provider is down. Instead the destination gets no new aggregate, snapshot or drop check; `watchError` says why.
- **W2 Zero-vote destinations fill the shortlist.** "Top 3 by votes, ties → cheapest groupTotal": with fewer than 3 voted destinations, the rest tie at 0 votes and the cheapest complete ones fill in. Incomplete ones lose ties. IATA is the last tie-break so the order is stable.
- **W3 Shortlist is re-read every run.** Votes can change between the cron and a manual check; each run picks its own shortlist. The Book tab's sparkline uses the same `selectShortlist` on the client (top one), so it follows the votes live.
- **W4 [DECISION] Drop emails are keyed per run (`drop|trip|jobId|user`), not per day.** Retries and duplicate deliveries of the same run never resend (the job ignores its own snapshot when finding the "previous" one, so a retry still detects the drop and the claim stops it). Two different runs the same day both email only if each finds a new ≥ max($50, 5%) drop against the newer snapshot; the 3-checks-per-day cap and the email caps bound it. One email per member lists every dropped destination. Each copy includes that member's own fare (not a budget).
- **W5 [DECISION] "First time" = once ever per (trip, destination, traveler).** The private key has no date, so after going back above budget and under again, no second email (unit-tested). The private email says "within the private budget you set" but never states the amount (the builder takes no budget). Known gap: if a run overwrites fares and then crashes before emailing, the retry's "previous" fare is already the new one, so that crossing is missed (never duplicated). Rare (storage failure mid-run); accepted.
- **W6 `watchQueuedAt` instead of a watch job id.** It's written before `enqueueJob`, so a fast job (all routes cached) can't finish before the mark lands and leave the button stuck. Older than 20 min = lost (`LIMITS.staleWatchMs`), same idea as R2. New trips columns `watchQueuedAt`, `watchError`; new error codes `watch_running`, `watch_ended`. `checkFaresNow` works on locked trips and regardless of the daily switch (the switch only controls the cron).
- **W7 Cron details.** "Today" is the America/Chicago calendar date (the cron's timezone) for the ≤ 1-day stop rule, in the cron, `checkFaresNow` and the UI. The 10-per-run limit is applied after the filter and before the per-trip skips, soonest departure first; with more than 10 watched trips, the later ones aren't watched that day. The cron also skips a trip whose manual check is still queued, and counts toward the same 3 watch checks/day. "Stops automatically" is enforced, not stored: `watchEnabled` isn't flipped. Not verified on a deployed app: the cron is unit-tested and the job runs in e2e via `checkFaresNow`; proof in production is `deepspace logs --search cron` → `[cron] fare-watch ok` plus a `[fare-watch] eligible …` line.
- **W8 [DECISION] The Book tab opens at status `results`.** The brief asks for the sparkline of "the locked destination, or the top shortlisted one"; the second case only exists before a lock, when Book was disabled. Before a lock it shows "No destination locked yet" plus the fare watch. One Phase 6 e2e assertion (Book disabled at results) was changed to match.
- **W9 Lock emails now go through the shared `deliverOnce`** (src/server/email-delivery.ts), with the same claim/cap/count rules; all 15 lock unit tests and the real-email api test pass unchanged. One small difference: if building a message throws, the claim is released (before, it stayed until stale).
