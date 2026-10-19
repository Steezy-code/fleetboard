// The flags Fleetboard passes to each agent CLI, checked against the installed CLI's own --help: CLIs
// drop and rename flags (Codex dropped --full-auto, and every Codex team worker failed to start).
// A CLI that is not installed is skipped; FLEETBOARD_CLI_PATH adds directories to look in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AGENTS } from '../../src/shared/agents'

const dirs = [...(process.env.FLEETBOARD_CLI_PATH ?? '').split(path.delimiter), ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean)
const which = (bin: string) => dirs.map((d) => path.join(d, bin)).find((p) => fs.existsSync(p))
/** What the CLI prints for these arguments (stdout and stderr: some print help on stderr). */
function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', CI: '1' } })
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}
const helps = new Map<string, string>()
function help(bin: string, sub: string[]): string {
  const key = [bin, ...sub].join(' ')
  if (!helps.has(key)) helps.set(key, run(bin, [...sub, '--help']))
  return helps.get(key)!
}
/** A flag missing from --help may still be taken (hidden): what does the CLI say when given it? */
const rejected = (bin: string, sub: string[], flag: string) => /unknown (option|argument|flag)|unexpected argument|unrecognized|invalid option/i.test(run(bin, [...sub, flag, '--help']))
const ID = '00000000-0000-4000-8000-000000000000'
/** the subcommand words an argument list starts with ("resume", "threads continue"), then its flags */
function split(args: string[]) {
  const sub: string[] = []
  for (const a of args) {
    if (!/^[a-z][a-z-]*$/.test(a)) break
    sub.push(a)
  }
  return { sub, flags: args.slice(sub.length).filter((a) => a.startsWith('-')) }
}

for (const agent of AGENTS) {
  if (agent.id === 'shell') continue
  const bin = which(agent.bin)
  test(`${agent.name}: every flag Fleetboard passes exists`, { skip: !bin && `${agent.bin} is not installed` }, () => {
    const base = agent.args ?? []
    // interactive launches: the agent's own args, then these
    const launches = [agent.yoloArgs, agent.editsArgs, agent.resumeArgs, agent.session?.start?.(ID), agent.session?.resume(ID)].filter((a): a is string[] => !!a?.length).map((a) => [...base, ...a])
    // headless runs stand alone
    if (agent.headless) launches.push(agent.headless('x'))
    for (const args of launches) {
      const { sub, flags } = split(args)
      const text = help(bin!, sub)
      for (const f of flags) assert.ok(text.includes(f) || !rejected(bin!, sub, f), `${agent.bin}${sub.length ? ' ' + sub.join(' ') : ''} has no ${f} (passed as: ${args.join(' ')})`)
      // a flag's fixed value ("--approval-mode auto_edit") must be one it takes
      for (let i = 0; i < args.length - 1; i++)
        if (args[i].startsWith('-') && /^[a-z][\w-]*$/.test(args[i + 1]) && args[i + 1] !== 'x' && args.indexOf(args[i + 1]) > sub.length - 1)
          assert.ok(text.includes(args[i + 1]), `${agent.bin} ${args[i]}: no value ${args[i + 1]}`)
    }
  })
}
