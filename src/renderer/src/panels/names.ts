// The names panels open by, and nothing else. The voice planner and the Helm list panel names for a
// model, and those modules run under node:test, so a list they can take must not pull in React or a
// single panel: registry.tsx is the side that ties each name to its component, in both directions.

/** Modals: useApp.openPanel(name, props) */
export const MODALS = ['spawn', 'presets', 'composer', 'missionMap', 'loops', 'handoff', 'memory', 'knowledge', 'skills', 'settings', 'code', 'markdown', 'documents', 'diagrams', 'fleetDiff', 'sweep'] as const
/** Drawers, the floating cards on the right: useApp.openDrawer(name, props) */
export const DRAWER_NAMES = ['orchestrator', 'usage', 'accounts', 'git', 'ci', 'chat', 'journal'] as const

export type ModalName = (typeof MODALS)[number]
export type DrawerName = (typeof DRAWER_NAMES)[number]
