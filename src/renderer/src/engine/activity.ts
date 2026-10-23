import { create } from 'zustand'

// What each console is doing, as the main process reads it off the screen (main/activity.ts): a few
// words like "editing `src/main/pty.ts`", or nothing, which the tile shows as its plain status.

interface Activity {
  of: Record<string, string>
}

export const useActivity = create<Activity>(() => ({ of: {} }))

export function setActivity(id: string, text: string | null) {
  useActivity.setState((s) => {
    if ((s.of[id] ?? null) === text) return s
    const of = { ...s.of }
    if (text) of[id] = text
    else delete of[id]
    return { of }
  })
}

export const activityOf = (id: string): string | undefined => useActivity.getState().of[id]
