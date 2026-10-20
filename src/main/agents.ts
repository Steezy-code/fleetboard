import { execFile } from 'node:child_process'
import type { AgentAvailability } from '@shared/types'
import { AGENTS } from '@shared/agents'
import type { MainContext } from './context'
import { loginEnv, which } from './env'
import { launch, launchOptions } from './platform'

let cache: AgentAvailability[] | null = null

async function version(bin: string): Promise<string | undefined> {
  const env = await loginEnv()
  return new Promise((resolve) => {
    const l = launch(bin, ['--version'], env)
    execFile(l.file, l.args, { env, timeout: 4000, ...launchOptions(l) }, (err, out) => {
      if (err) return resolve(undefined)
      resolve(String(out).trim().split('\n')[0].slice(0, 60))
    })
  })
}

export async function detectAgents(force = false): Promise<AgentAvailability[]> {
  if (cache && !force) return cache
  const all = await Promise.all(
    AGENTS.map(async (a) => {
      const p = await which(a.bin)
      return { id: a.id, path: p } as AgentAvailability
    })
  )
  // Versions only for installed agents, in the background of this call.
  await Promise.all(all.filter((a) => a.path && a.id !== 'shell').map(async (a) => (a.version = await version(a.path!))))
  cache = all
  return all
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('agents:detect', (_e, force?: boolean) => detectAgents(force))
}
