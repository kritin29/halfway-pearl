/**
 * Multi-user collaboration spec — verifies two users sign in into
 * separate browser contexts and the app distinguishes them.
 *
 * `users(2)` takes any two accounts from your pool, so this spec passes on a
 * fresh app with no setup beyond having two test accounts:
 *   npx deepspace test accounts list
 *   npx deepspace test accounts create --email a@deepspace.test --name "A" --password-stdin
 *
 * Ask for accounts *by name* (`users(['Alice', 'Bob'])`) only when the
 * behaviour under test depends on which identity acts — otherwise naming them
 * couples the spec to one machine's pool.
 *
 * The `users` fixture handles sign-in caching (per-account storageState
 * persisted to `~/.deepspace/playwright-states/`), context creation, and
 * cleanup. No need to manage browser contexts manually.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

// A machine that has never created test accounts is the normal state of a
// fresh checkout, and there `users()` throws — turning "you have no pool yet"
// into three red tests about the app, which it is not. Skip the file instead
// and say what creates the pool. The count is of accounts usable HERE: the
// pool is global per developer, but passwords live only on the machine that
// created the account.
const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" ' +
    '--password-stdin`, or fetch existing pool accounts with `npx deepspace test accounts recover --all`.',
)

test('each browser renders its own signed-in account', async ({ users }) => {
  const [a, b] = await users(2)

  // /trips is dynamic (under src/pages/(app)/), so it mounts the nav shell;
  // '/' is the static landing and has no navigation.
  await Promise.all([a.page.goto('/trips'), b.page.goto('/trips')])

  // Email, not name. The page renders the *session's* `name || email`, while
  // `user.name` here comes from the LOCAL account registry — and the two are
  // not the same fact: a display name is optional, and an account recovered on
  // another machine has none stored locally at all. The email is the credential
  // the context signed in with, so it is the one identity both sides agree on,
  // and asserting it proves the page is showing THIS browser's account.
  // The two accounts are distinct, so two exact matches is also the proof that
  // the contexts are not sharing one session.
  for (const user of [a, b]) {
    await expect(user.page.getByTestId('app-navigation')).toBeVisible({ timeout: 15_000 })

    // The identity chip shows `name || email`. Its text is not predictable, but
    // its presence is: something must be there once the profile has loaded.
    // (It is `hidden sm:inline` in some templates, so assert text, not
    // visibility.)
    await expect(user.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })

    await user.page.getByRole('button', { name: 'Account menu' }).click()
    await expect(user.page.getByTestId('nav-user-email')).toHaveText(user.email, {
      timeout: 15_000,
    })
  }
})

/**
 * CLAUDE.md: a failed resource shows error-with-retry and never reloads the
 * page. The invite preview (`previewInvite` through useAsyncResource) is a
 * real Halfway resource: fail it at the network boundary, retry, and check
 * the page recovered in place (same URL, a window marker survives).
 */
test('a failed invite lookup offers a retry that recovers without a page reload', async ({ users }) => {
  const [user] = await users(1)
  let failing = true
  let calls = 0
  await user.page.route('**/api/actions/previewInvite', async (route) => {
    calls += 1
    if (failing) {
      // A gateway error page: the client classifies it as a retryable server_error.
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad gateway' })
    } else {
      await route.fallback()
    }
  })

  await user.page.goto('/join/nosuchcode123')
  await expect(user.page.getByText('Could not load this invite')).toBeVisible({ timeout: 15_000 })
  await user.page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1))
  const url = user.page.url()

  failing = false
  const before = calls
  await user.page.getByRole('button', { name: 'Try again' }).click()
  // The real answer for a code that doesn't exist.
  await expect(user.page.getByTestId('join-error')).toContainText('That invite link doesn’t match a trip', { timeout: 15_000 })
  expect(calls).toBeGreaterThan(before)
  expect(user.page.url()).toBe(url)
  expect(await user.page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1)
})
