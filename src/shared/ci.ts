// What counts as red CI, for the main process and the board alike.

/**
 * GitHub's conclusions (workflow runs and check runs) that mean "this failed". Cancelled and skipped
 * are not failures. 'error' is a commit-status word; it is kept in case a check ever reports it.
 */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'error'])

export const isFailing = (conclusion: string | null | undefined) => FAILING_CONCLUSIONS.has((conclusion || '').toLowerCase())
