// The calendar day an instant falls on, as the user's clock reads it.

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * `YYYY-MM-DD` of the *local* calendar day: what calendars, the journal's files and the usage heatmap
 * mean by "today". `toISOString().slice(0, 10)` is the UTC day, and west of UTC in the evening that is
 * already tomorrow.
 */
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
