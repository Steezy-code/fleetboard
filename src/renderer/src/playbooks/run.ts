import type { FleetMember } from '@shared/fleet'
import { invoke } from '../lib/api'
import { activeWs, allConsoles, useApp } from '../state/store'
import { CONSOLE_H, CONSOLE_W, nextName } from '../engine/consoles'
import { confirmTeamFolder } from '../engine/fleet'
import { draftCharter, gateCharter } from '../fleet/charter'
import { playbookById } from './catalog'

/** Remember what was typed last time, per playbook. */
export async function lastInputs(id: string): Promise<Record<string, string>> {
  const all = ((await invoke('store:getGlobal', 'playbookInputs')) ?? {}) as Record<string, Record<string, string>>
  return all[id] ?? {}
}
async function rememberInputs(id: string, inputs: Record<string, string>) {
  const all = ((await invoke('store:getGlobal', 'playbookInputs')) ?? {}) as Record<string, Record<string, string>>
  await invoke('store:setGlobal', 'playbookInputs', { ...all, [id]: inputs })
}

/**
 * Run a playbook on the open project (or on projectPath, opened first). Team playbooks start their
 * own Lead with the playbook's brief; built-in ones open their panel. Returns the Lead, if any.
 */
export async function runPlaybook(id: string, inputs: Record<string, string> = {}, opts: { projectPath?: string } = {}): Promise<FleetMember | null> {
  const pb = playbookById(id)
  if (!pb) throw new Error(`Unknown playbook ${id}`)
  const app = useApp.getState()
  if (pb.panel) {
    app.openPanel(pb.panel)
    return null
  }
  if (opts.projectPath && app.project?.path !== opts.projectPath) await app.openProject(opts.projectPath)
  const p = useApp.getState().project
  if (!p) throw new Error('Open a project first')

  const values = Object.fromEntries(pb.inputs.map((i) => [i.key, (inputs[i.key] ?? i.value ?? '').trim()]))
  const missing = pb.inputs.find((i) => !i.optional && i.kind !== 'switch' && !values[i.key])
  if (missing) throw new Error(`${missing.label} is needed`)
  rememberInputs(id, values)

  const goal = pb.brief!(values)
  // short title for the Ready card, branch name and merge commit: "Hotfix: wordCount gives 1 for…"
  const given = pb.inputs.map((i) => values[i.key]).filter((v): v is string => !!v && v !== 'yes')
  const first = given[0]
  const title = first ? `${pb.name}: ${first.length > 70 ? first.slice(0, 68) + '…' : first}` : pb.name
  // The charter is about what the user asked for, in their words. The playbook's step list is the goal, and
  // goes to the Lead after the charter because it is not the request.
  const charter = await gateCharter(await draftCharter(given.length ? `${pb.name}: ${given.join('; ')}` : pb.name))
  if (!charter) return null
  if (!(await confirmTeamFolder(p.path))) return null
  app.toast(`${pb.name}: starting a Lead…`)
  const lead = await invoke<FleetMember>('fleet:startLead', { projectId: p.id, projectPath: p.path, goal, title, charter })

  // extra tiles (live preview, dev server) go to the right of the new Lead once it is on the board
  const tiles = pb.tiles?.(values) ?? []
  if (tiles.length) placeTiles(lead.id, tiles, p.path)
  return lead
}

function placeTiles(leadId: string, tiles: { type: 'web' | 'console'; data: Record<string, any> }[], cwd: string) {
  let tries = 0
  const tick = () => {
    const ws = activeWs()
    const lead = ws?.nodes.find((n) => n.id === leadId)
    if (!lead) {
      if (tries++ < 40) window.setTimeout(tick, 150)
      return
    }
    const app = useApp.getState()
    let y = lead.y
    for (const t of tiles) {
      if (t.type === 'web') {
        app.addNode({ type: 'web', x: lead.x + lead.w + 40, y, w: 900, h: 620, data: { url: t.data.url } })
        y += 660
      } else {
        const taken = allConsoles().map((c) => c.data.name as string)
        app.addNode({
          type: 'console',
          x: lead.x + lead.w + 40,
          y,
          w: CONSOLE_W,
          h: Math.round(CONSOLE_H * 0.7),
          data: { agentId: t.data.agentId ?? 'shell', command: t.data.command, name: t.data.name ?? nextName(taken), cwd, launch: 'fresh', createdAt: Date.now() }
        })
        y += Math.round(CONSOLE_H * 0.7) + 40
      }
    }
  }
  tick()
}
