import { invoke } from './api'
import { useApp } from '../state/store'

// The renderer half of main's journal (src/main/journal.ts): what the app did while nobody was
// watching. A toast lives 4200 ms, so anything that happens unattended needs a line here too.

export function journal(kind: string, text: string, detail?: Record<string, unknown>): void {
  void invoke('journal:append', { kind, text, project: useApp.getState().project?.path, detail }).catch(() => {
    // main logs its own failure to write; nothing here should fail because the record did
  })
}
