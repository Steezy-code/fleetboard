// Walking a list by neighbours, without indexing it.
//
// Reading list[i] and list[i + 1] inside a loop is the shape almost all of this codebase's indexing
// takes — segments of a polyline, corners of a polygon, a curve that needs a point either side.
// Under noUncheckedIndexedAccess every one of those reads is a maybe-value, although the loop's own
// bounds settled it, and handling that at each call site means either a check that cannot fail or an
// assertion that says the flag was wrong. Done once here, the call sites say what they mean and get
// values: `for (const [a, b] of pairs(pts))`.
//
// A list whose own items may be undefined is not a list these walk: such an item is skipped.

/** Consecutive pairs: (a0,a1), (a1,a2), … Nothing at all for a list shorter than two. */
export function* pairs<T>(list: readonly T[]): Generator<[T, T]> {
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (a !== undefined && b !== undefined) yield [a, b]
  }
}

/** Consecutive pairs all the way round: the last one closes back to the first. */
export function* pairsRound<T>(list: readonly T[]): Generator<[T, T]> {
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const b = list[(i + 1) % list.length]
    if (a !== undefined && b !== undefined) yield [a, b]
  }
}

/** Every item with the one before and the one after it, all the way round. */
export function* triplesRound<T>(list: readonly T[]): Generator<[T, T, T]> {
  const n = list.length
  for (let i = 0; i < n; i++) {
    const prev = list[(i - 1 + n) % n]
    const at = list[i]
    const next = list[(i + 1) % n]
    if (prev !== undefined && at !== undefined && next !== undefined) yield [prev, at, next]
  }
}

/** Every window of four: (a0..a3), (a1..a4), … Nothing for a list shorter than four. */
export function* quads<T>(list: readonly T[]): Generator<[T, T, T, T]> {
  for (let i = 0; i + 3 < list.length; i++) {
    const a = list[i]
    const b = list[i + 1]
    const c = list[i + 2]
    const d = list[i + 3]
    if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) yield [a, b, c, d]
  }
}
