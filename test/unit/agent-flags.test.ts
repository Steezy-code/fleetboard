// The flags Fleetboard passes to each agent CLI, checked against the installed CLI's own --help: CLIs
// drop and rename flags (Codex dropped --full-auto, and every Codex team worker failed to start).
// A CLI that is not installed is skipped; FLEETBOARD_CLI_PATH adds directories to look in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AGENTS } from '../../src/shared/agents'

const dirs = [...(process.env.FLEETBOARD_CLI_PATH ?? '').split(path.delimiter), ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean)
const which = (bin: string) => dirs.map((d) => path.join(d, bin)).find((p) => fs.existsSync(p))
const help = (bin: string, args: string[]) => {
  try {
    return execFileSync(bin, [...args, '--help'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e: any) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}
const flags = (args: string[] = []) => args.filter((a) => a.startsWith('-'))

for (const id of ['claude', 'codex', 'gemini']) {
  const agent = AGENTS.find((a) => a.id === id)!
  const bin = which(agent.bin)
  test(`${agent.name}: every flag Fleetboard passes exists`, { skip: !bin && `${agent.bin} is not installed` }, () => {
    const top = help(bin!, [])
    const used = [...flags(agent.yoloArgs), ...flags(agent.editsArgs), ...flags(agent.session?.start?.('00000000-0000-4000-8000-000000000000'))]
    // flags given after a subcommand belong to that subcommand's help
    const sub = (args?: string[]) => (args && !args[0]?.startsWith('-') ? args[0] : undefined)
    for (const args of [agent.resumeArgs, agent.session?.resume('00000000-0000-4000-8000-000000000000'), agent.headless?.('x')]) {
      const s = sub(args)
      if (!s) {
        used.push(...flags(args))
        continue
      }
      const subHelp = help(bin!, [s])
      for (const f of flags(args)) assert.ok(subHelp.includes(f), `${agent.bin} ${s} has no ${f}`)
    }
    for (const f of new Set(used)) assert.ok(top.includes(f), `${agent.bin} has no ${f}`)
    // the values given to a flag with fixed choices
    for (const args of [agent.yoloArgs, agent.editsArgs])
      for (let i = 0; args && i < args.length - 1; i++) if (args[i].startsWith('-') && !args[i + 1].startsWith('-')) assert.ok(top.includes(args[i + 1]), `${agent.bin} ${args[i]}: no value ${args[i + 1]}`)
  })
}
