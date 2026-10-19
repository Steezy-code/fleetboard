// Consoles a crashed run left running are ended by the next launch: only those, whole process groups,
// and never a later process that was given the same pid.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const linux = fs.existsSync('/proc/self/stat')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-orphans-'))
process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
const { RunRecord, endOrphans, processStart } = await import('../../src/main/orphans')
const file = path.join(dir, 'record.json')
const spawned: number[] = []
after(() => {
  for (const pid of spawned)
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
})

/** running (a process that has ended but is not reaped yet, a zombie, is not) */
const alive = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}
/** A console-like process: its own session and group, ignoring the hangup, with a child that does too. */
function hupless(script = `trap '' HUP; sleep 300 & echo $! > ${dir}/child-$$; wait`) {
  const p = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' })
  spawned.push(p.pid!)
  return p.pid!
}
const childOf = async (pid: number) => {
  const f = path.join(dir, `child-${pid}`)
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 20))
  return Number(fs.readFileSync(f, 'utf8'))
}
const write = (entries: object) => fs.writeFileSync(file, JSON.stringify(entries))

test('the record follows consoles as they start and end; a respawn under the same id keeps the new one', () => {
  const r = new RunRecord(file)
  r.add('con_a', process.pid)
  r.add('con_b', process.pid)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['con_a', 'con_b'])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).con_a.start, processStart(process.pid))
  r.remove('con_a', process.pid)
  r.remove('con_b', 12345) // an earlier process of that console ending late
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['con_b'])
  assert.equal(processStart(2 ** 22 + 7), null)
})

test('a console left running that ignores the hangup is ended, with its children', { skip: !linux && 'reads /proc' }, async () => {
  const pid = hupless()
  const child = await childOf(pid)
  write({ con_a: { pid, start: processStart(pid) } })
  process.kill(-pid, 'SIGHUP')
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(alive(pid) && alive(child), 'the hangup alone does not end it')
  assert.equal(await endOrphans(300, file), 1)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(pid), false)
  assert.equal(alive(child), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'record cleared')
})

test("a console whose CLI ended but whose child still runs: the child is ended", { skip: !linux && 'reads /proc' }, async () => {
  const pid = hupless(`trap '' HUP; sleep 300 & echo $! > ${dir}/child-$$; sleep 0.3`)
  const child = await childOf(pid)
  const start = processStart(pid)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(processStart(pid), null, 'the CLI has ended')
  assert.ok(alive(child))
  write({ con_a: { pid, start } })
  assert.equal(await endOrphans(300, file), 1)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(child), false)
})

test("a shell console's nohup job, its shell gone, is the user's: left alone", { skip: !linux && 'reads /proc' }, async () => {
  const pid = hupless(`trap '' HUP; sleep 300 & echo $! > ${dir}/child-$$; sleep 0.3`)
  const child = await childOf(pid)
  const start = processStart(pid)
  await new Promise((r) => setTimeout(r, 600))
  write({ con_sh: { pid, start, group: false } })
  assert.equal(await endOrphans(200, file), 0)
  assert.ok(alive(child))
  process.kill(child, 'SIGKILL')
})

test('a process with a recorded pid but another start time is someone else: left alone', { skip: !linux && 'reads /proc' }, async () => {
  const pid = hupless()
  write({ con_a: { pid, start: 'an earlier process' }, con_b: { pid: process.pid, start: 'not this test' } })
  assert.equal(await endOrphans(200, file), 0)
  assert.ok(alive(pid))
  process.kill(-pid, 'SIGKILL')
})

test('a missing or broken record is nothing to do', async () => {
  fs.rmSync(file, { force: true })
  assert.equal(await endOrphans(100, file), 0)
  fs.writeFileSync(file, '{"con_a": {"pid": "1; rm -rf /", "start": 3}, "con_b": null, "x": {"pid": 1, "start": "0"}}')
  assert.equal(await endOrphans(100, file), 0)
  fs.writeFileSync(file, 'not json')
  assert.equal(await endOrphans(100, file), 0)
})
