// What a team member's worktree cost, as main/usage.ts counts it (a Tot), and the one figure worth
// showing from it.

export interface Spent {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

/**
 * Tokens that count against the budget: input, output and cache *writes*. Cache reads are left out,
 * the same way main/usage.ts counts a limit window.
 *
 * `total` includes cache reads, and on a long agent session they swamp everything else — a worker
 * that read 562k from cache and wrote 38k reads as "604k", the same size as every other worker, so
 * the number stops telling you which one was expensive. This one does.
 */
export const billed = (s: Spent) => s.input + s.output + s.cacheCreate
