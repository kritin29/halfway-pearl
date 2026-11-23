/**
 * Generic error text for the cron and job boundaries (NOTES D3 ruling).
 *
 * The CronRoom stores a failed task's `error.message` in its run history,
 * which anyone can read (token-less sockets are viewers). The JobRoom stores
 * a failed job's message on the job row. Both also log the error with its
 * cause chain. Storage errors can echo the values they refused: for example,
 * a duplicate `emailLog` key contains a user id. So nothing raw may cross
 * those boundaries. Only these fixed messages do:
 *
 *   "<label> failed: storage error at \"<step>\""   (a `must()` step label)
 *   "<label> failed: storage error"
 *   "<label> failed: unexpected error"
 *
 * A step label is a code literal like 'load trip'. It's included only if it
 * is plain lowercase words, so a label built from data (e.g. the fare cache
 * key) is dropped. Pure: no SDK imports.
 */

/** Step labels allowed in error text: lowercase letters and spaces only. */
const SAFE_STEP = /^[a-z][a-z ]{0,47}$/

/** The generic reason for `err`; never any of its message text. */
export function safeErrorText(err: unknown): string {
  if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ToolError') {
    const step = (err as { step?: unknown }).step
    return typeof step === 'string' && SAFE_STEP.test(step) ? `storage error at "${step}"` : 'storage error'
  }
  return 'unexpected error'
}

/**
 * A fresh Error with only generic text and no `cause`, to throw across the
 * cron/job boundary in place of `err`. `label` must be a code literal (a task
 * name or job type).
 */
export function genericFailure(label: string, err: unknown): Error {
  return new Error(`${label} failed: ${safeErrorText(err)}`)
}
