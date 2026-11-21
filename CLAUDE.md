See [AGENTS.md](./AGENTS.md) for the DeepSpace basics. Project-specific rules below take precedence where they differ.

# Halfway — rules for Claude Code

## Read first
- `SPEC.md` is the product/technical spec. Follow it. If the DeepSpace docs or installed types contradict it, the docs/types win: write the conflict to `NOTES.md` and tell me before changing direction.
- Before touching an area, read the relevant DeepSpace docs (index: https://docs.deep.space/llms.txt, append `.md` to any page). Required before schemas/worker/sync: `/concepts/*`. Also: `/concepts/permissions`, `/guides/server-actions`, `/guides/background-jobs`, `/guides/scheduled-jobs`, `/guides/external-apis`, `/guides/testing`.
- Exact signatures: `node_modules/deepspace/dist/*.d.ts`.

## Source control (important)
- **I (the developer) explicitly chose GitHub as the source authority.** The repo has a GitHub `origin`. This overrides the AGENTS.md default.
- **Never run `npx deepspace push`, `pull`, `clone` or workspace commands.** Use plain git.
- Never change or add git remotes. Never `git push --mirror`. Never force-push.
- Deploys ship the working tree including uncommitted changes — commit before I deploy.

## Security & spend
- Identity comes only from the verified JWT. Never accept a userId from params or the client.
- Server actions and jobs run with RBAC off. **Every action loads the trip and checks membership/organizer itself.**
- Rows with `memberIds` are written only by actions/jobs. Clients write only their own `travelers` row (writableFields) and own `budgets` row.
- Never expose another user's budget, email, or raw `users` row to the client, a log, or a model.
- Never call paid integrations from the browser. Always through actions/jobs, after cap checks in `usage`.
- Never set `anonymous: true` on integrations. Never flip billing modes to make something work.
- Never hand-edit `.dev.vars`, never print secrets, never put credentials in commits, specs, or screenshots.

## Code style
- Business logic in pure modules with Vitest unit tests: `src/lib/flights.ts`, `src/lib/ranking.ts`, `src/lib/caps.ts`, `src/lib/watch.ts`.
- Data hooks only inside the `(app)/` provider boundary. Top-level pages are static.
- Use `useMutations().ready` to gate write controls; confirmed writes where navigation depends on success.
- Every async UI: loading, empty, error-with-retry, success. A failed resource never reloads the page.
- UI primitives from `src/components/ui`. Treat the scaffold theme/home as placeholders.
- Small, focused commits with clear messages.

## Testing
- `npx deepspace test run` (smoke + api) and `npx deepspace test run unit` after every phase; `npx deepspace test run e2e` for two-user specs.
- Two-user tests use `import { test, expect } from 'deepspace/testing'` and `users(2)`.
- At most one real call per integration endpoint per test run, never in loops. Mock only the external integration boundary (use the saved SerpApi fixture).
- Don't claim something works until you've run the test or command and seen it pass. Show me the output.

## Working with me
- Work in the phase I give you. Stop at the end of the phase, summarize what changed (files, decisions, anything uncertain), and list what I should manually verify.
- If a DeepSpace CLI command refuses, follow its `code`/`action`; if it ships no action, stop and ask me.
- Append a short entry to `AGENT_LOG.md` at the end of each phase (what you did, what broke, what you're unsure about). I'll add my own verification notes.
