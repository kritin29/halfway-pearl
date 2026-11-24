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

## Phase 9 findings (2026-11-23)
- **D1 [CONFLICT with SPEC §9 / Phase 7 W7] Cron runs don't show up in `deepspace logs`.** SPEC said proof of a run is `deepspace logs --search cron` → `[cron] fare-watch ok`. The CronRoom history shows a real run (`fare-watch`, started 2026-11-23T14:00:00.434Z, success, 253 ms), but `deepspace logs --since 7d --search cron` lists only `GET /internal/cron/tasks` arming requests, and `--search fare-watch` finds nothing. There are no log events at all between 08:55 and 11:24 local that day. So alarm-time console output (the SDK's `[cron] … ok` and our `[fare-watch] eligible …`) isn't in the log feed, at least on this plan. The history wins; SPEC §9 is updated (#52). How to read it: `wss://halfway-pearl.app.space/ws/cron/app:<DEEPSPACE_APP_ID>` with no token → `auth {canWrite:false}`, `cron.tasks` (lastRunAt, nextRunAt), `cron.history` (last 50 finished runs).
- **D2 Why no runs on Nov 21 and 22.** The `fare-watch` task (Phase 7, committed 2026-11-21 18:52Z) was first deployed in release #6 (2026-11-22 16:24Z). That's after that day's 14:00Z slot, so the first slot was 2026-11-23 14:00Z, which ran. Release #5 (2026-11-21 18:22Z) shows readiness probes but no `/internal/cron/tasks` wake, which is what `armCronRoom` does when the task list is empty. And if the task had been armed then, a 2026-11-22 14:00Z row would be in the history (500 rows kept); there isn't one. Nothing to fix. The next run is 2026-11-24T14:00Z.
- **D3 [RESOLVED 2026-11-23: keep it readable; error text generic]** The developer kept the history readable and required that cron/job error text never contain user data. `src/cron.ts` and `src/jobs.ts` now throw only `genericFailure(...)` (`src/lib/safe-error.ts`): a fresh Error with no cause, whose text is `"<task> failed: storage error at \"<step>\""` (step = a plain lowercase `must()` label), `"… storage error"` or `"… unexpected error"`. `ToolError` carries its `step` separately. The fare-search job's own failure logs and `watch-start`'s enqueue log use the same generic text. Unknown task/job names aren't echoed. Test: `src/server/safe-errors.test.ts` runs the real `runTask`/`runJob` against a storage stub whose errors echo a user id, an email, a budget and a trip name; none appear in the thrown text or in any log line. Not changed: `defineAction`'s `[action] … failed: <message>` log for actions (owner-only logs, not the cron/job boundary); the same sanitizer could be applied there. Original finding: **The cron history is readable by anyone.** `/ws/cron/:roomId` accepts token-less sockets as `viewer` (writes are refused). It exposes task names, run times and error strings. (I first wrote that the errors were already generic. That was wrong: before the fix above, a storage failure's raw text, which can echo stored values, would have reached the history.)
- **D4 The approved SerpApi retry (SPEC §7 body) returned the same 429** ("Your account has run out of searches.", 502 from the platform, 344 ms, `billing: "released"`) at 2026-11-23T16:38Z. Not retried. R7 stands.
- **D5 [DECISIONS] Demo mode** (SPEC §14):
  - Separate cap (3/user/day, `demo:created:user:<id>`), not counted toward the 10/day trip cap; demo searches don't add to the per-user "trips searched today" (otherwise three demos would block a user's real searches). Per-trip limits still apply.
  - Caller flies from ORD (editable); ghosts BOS and DEN; destinations AUS/BNA/SAN/MIA, the set the results e2e already proves gives three different orders.
  - `watchEnabled = 0` and `setWatch` refuses demo trips (`demo_trip`); the cron also filters `isDemo` in `selectWatchTrips` (before the 10-per-run limit) and re-checks the loaded row.
  - Fixture prices are deterministic per route and cached < 6 h, so "Check fares now" on a demo adds a flat sparkline point and never a drop. Honest, but it won't show a drop alert.
  - Demo trips can still be joined by invite (the invite page shows the label); emails stay off for everyone.
  - `isDemo` is `immutable`. The fake store enforces it for server code, and RecordRoom's `immutable` rule should do the same in production. I didn't test a server-side flip against the real room; client writes are refused in e2e.
  - Dev/test seam: `testName` (a `__test-` name) only under `ALLOW_DEBUG_ROUTES === 'true'`; the e2e rewrites the real button's request at the network layer to add it.
- **D6 Dev server crash (once):** the first e2e launch died with `Error: UNKNOWN: unknown error, watch '…\dist\client\favicon.ico'` (a Windows file-watcher error on this morning's deploy output). The immediate re-run started fine; nothing changed in between.

## Phase 11 findings: whole-app review (2026-11-23)
Four read-only reviewers (server, pure logic, UI, schemas/config); every finding below was re-checked in the code before acting.

**Fixed (tests added):**
- **E1 [SECURITY] The integration proxy was a blocklist.** `/api/integrations/:name/:endpoint` proxied any integration NOT in `src/integrations.ts` with developer billing (the owner's token, no `usage` caps), so any signed-in DeepSpace account could call other paid catalog integrations at the owner's expense. The name lookup was also case-sensitive while the path check isn't, so `SerpApi/flights` or `EMAIL/send` skipped the C4 403. Now: lowercase lookup, and unlisted names get 403. api tests for `SerpApi/flights`, `EMAIL/send`, `openai/chat-completion`. (Not mutation-checked: on the old code those requests would have been forwarded upstream.)
- **E2 Lock after a late join.** `joinTrip`/`addGhost` are allowed at status `results`, but the saved `complete` didn't know about the newcomer: the card still showed a total and Lock, and `lockTrip` (which only read `complete`) locked a destination they had no fare for. `lockTrip` now re-checks every current traveler for an ok fare row (`incomplete`, "Run Find fares again"); result cards treat a traveler with no fare row as missing; the guide sends a newcomer at `results` without airports to Crew.
- **E3 [PRIVACY] fitsAll guard and $0 home fares.** A budgeted traveler who lives at the destination always fits, so they counted toward the 3 without hiding anyone (V fits, home traveler fits → a 0 points at the third person). They no longer count.
- **E4 Ghost roster frozen during a search** (`search_running`); no new ghosts on a locked trip (`trip_locked`, like `joinTrip`). Removing a ghost after a lock still works.
- **E5 AI suggestions could be a traveler's home airport** (prompt asked, code didn't enforce); home airports now count as taken.
- **E6 UI:** the page/tab entrance animation used `fill-mode: both`, which keeps a transform active and would trap the SDK's non-portaled sign-in overlay; now `backwards`. `YourSettings` never followed a change made on another device (compared against the new saved values); now compares against the previous ones. The airport list closes on blur and sets `aria-activedescendant`. Demo label added to the two Book cards without one. Lock, ghost booked toggles and "Email booking links again" gated on `ready`.
- **E7 Date picker vs UTC day:** the picker allowed local "today", which the client/server rule (UTC day) rejects every evening in the Americas; its minimum is now the later of the two.
- **E8 `text()` joined words across a line break** ("Sam\nSmith" → "SamSmith"); whitespace controls now become a space.

**Not fixed: open, each with the fix I'd make** (also summarized in README "Known limitations").
- **E9 [CONFLICT SPEC §7 vs §8] A full search during an outage wipes earlier results.** §8 says mark unanswered pairs `error`; §7 says return to results "if earlier results exist". With a 429 on the first call, every uncached pair becomes `error`, all candidates `complete: 0`, and status goes to `gathering`. Can't happen today: no real trip has ever had live results.
  *Fix:* in full mode, when the run ends on `provider_unavailable`, treat unanswered pairs like watch mode (W1): keep their previous fare rows, skip the aggregate for any destination with an unanswered pair, and keep status `results` if any earlier results exist. Then amend §8 to match §7.
- **E10 Group drop email when the group changes.** `detectGroupDrop` compares totals across snapshots without checking that the same travelers are in both; removing a ghost (or loosening constraints) can send "BNA got $400 cheaper".
  *Fix:* add `groupKey` to `fareSnapshots` (sorted traveler ids plus a hash of each traveler's constraints), and have `detectGroupDrop` compare only against the latest snapshot with the same key. Old snapshots without a key never count as a drop.
- **E11 Caps are soft under parallel requests**, not just ±1: N simultaneous `suggestCandidates`/`startSearch`/create calls all pass the same count (small sums; `useAction` already blocks repeats within a tab). A double `startSearch` from two tabs spends 2 of the 2 daily searches.
  *Fix:* reserve before spending: create a claim row with `uniqueOn` per slot (e.g. `usage:<day>:<key>:<n>`, the `emailLog` pattern), make the call only if the claim landed, and delete the claim when the call isn't made or is refunded.
- **E12 `startSearch` racing `lockTrip`** (two organizer tabs, near-simultaneous) can end with the trip back at `results` after lock emails went out.
  *Fix:* in `beginFullSearch`, re-read the trip after writing `searching` and back out if it's now `locked`; and at job finish, re-read status and never write `results` over `locked` (the job's `status === 'locked'` check reads the row loaded at the start).
- **E13 A thrown email send leaves its claim `sending`** (e.g. a non-JSON error body), so a retry within 10 min reports it already sent. Kept on purpose: releasing a claim whose outcome is unknown risks a double send.
  *Fix:* catch the throw in `deliverOnce`, mark the claim `unknown` (not `sending`) with its time, report it as `failed`, and let "Email booking links again" (and the job retry) resend `unknown` claims older than ~2 minutes, accepting a rare duplicate over a lost email.
- **E14 Smaller,** with fixes:
  - A watch run fails and retries if a destination is removed mid-run (`update candidate` on a missing row). *Fix:* treat not-found on that update as "skip this destination".
  - Tab switches unmount the Crew panel and drop unsaved edits. *Fix:* `keepMounted` on the Crew `TabsContent`, or warn when settings/budget are dirty.
  - The guide says "Lock the destination" even when no card is complete. *Fix:* pass a `lockableCount` into `nextStep` and say "Find fares again so everyone has a fare" when it's 0.
  - `homeAirports` isn't shape-checked before the lock email's missing-fare branch (`[5]` would throw and stop later emails). *Fix:* run it through `knownHomeAirports` (as the fare search does) in `lock-emails.ts` and `watch-alerts.ts`.
  - `/ws/yjs/:docId` and `/ws/:roomId` accept any id from a signed-in user (storage only, no app data; the app uses neither). *Fix:* remove both routes, or restrict `roomId` to `SCOPE_ID`.
  - The CSP in `public/_headers` has no `script-src`/`default-src`. *Fix:* add `default-src 'self'; script-src 'self'` plus the hosts the app needs (Google Fonts styles and font files, the DeepSpace API and websocket origins), and test the deployed site before shipping.

## Phase 11b: delete trip, sign-in wording, page scroll (2026-11-24)
- **F1 [DECISION, developer ruling] Delete only, not leave.** `deleteTrip` (organizer) deletes every row with the trip's `tripId` in `votes, fares, fareSnapshots, candidates, budgets, emailLog, travelers` (`deleteWhere`, paged), then the trip row. Children first, so a partial failure leaves the trip in place to retry rather than orphans nobody can reach. Kept: `usage` (deleting must not reset a cap), `fareCache` (per route, 6 h). Refused while a search runs (unless stale, as `startSearch`) or a watch run is queued, because the job would write rows for a deleted trip. Not covered: the daily cron enqueueing a watch run in the instant between the check and the delete (it would write a few orphan fares/snapshots under a missing trip, unreadable by anyone but the creator, i.e. the owner). Leave-trip stays out: SPEC §5's createdBy limitation.
- **F2 Sign-up.** DeepSpace has no email sign-up: the SDK documents the overlay's email form as "for test accounts created via CLI/API", and `AuthOverlay` has no prop to hide it. The first Google/GitHub sign-in creates the account. `src/components/SignInOverlay.tsx` passes Halfway's title and a description saying so; the signed-out panel says it too.
- **F3 Empty scroll after the last card.** The fare-watch sparkline's `sr-only` list (`position: absolute`) had no positioned ancestor inside the app's scroll box, so it was placed against the page and stretched the document (1699 px at 1280×800) below `main`. `main` is now `relative`; measured after: the document is exactly the window height and `main` ends 24 px (its padding) after the content.

