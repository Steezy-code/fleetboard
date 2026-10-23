import { useEffect } from 'react'
import { create } from 'zustand'
import type { GoalIdea } from '@shared/types'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { useHelm } from '../voice/helm/helm'

// The open board's first goals (main/starter.ts), for the empty board and the "Try …" hint. Read
// once per project per run: they come from files that do not change while you look at an empty board.

const useIdeas = create<{ byRoot: Record<string, GoalIdea[]> }>(() => ({ byRoot: {} }))
const asked = new Set<string>()
const NONE: GoalIdea[] = []

export function useGoalIdeas(): GoalIdea[] {
  const root = useApp((s) => s.project?.path)
  const ideas = useIdeas((s) => (root ? s.byRoot[root] : undefined))
  useEffect(() => {
    if (!root || asked.has(root)) return
    asked.add(root)
    invoke<GoalIdea[]>('starter:goals', root).then(
      (r) => useIdeas.setState((s) => ({ byRoot: { ...s.byRoot, [root]: r } })),
      () => asked.delete(root)
    )
  }, [root])
  return ideas ?? NONE
}

/** Put a goal in the command bar, ready to send or change: Enter is still the user's. */
export const offerGoal = (text: string) => useHelm.setState((s) => ({ draft: { text, n: (s.draft?.n ?? 0) + 1 } }))
