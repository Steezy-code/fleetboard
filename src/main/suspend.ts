// Pause and resume a console's processes on Windows. There is no SIGSTOP there, but Windows has its
// own freeze — NtSuspendProcess — and no way to reach it from Node without a native module. So a small
// PowerShell script does it, the way the Claude hooks already fall back to PowerShell: written once
// beside them, and run with the console's root pid.
//
// A real freeze is the point. node-pty can stop reading a pty instead, which looks like a pause until
// the agent that is not printing anything carries on calling an API with the user's tokens.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dirs } from './paths'

/**
 * Every process in one console's tree, parents before children. Suspending in that order means a
 * process that could still start a child is frozen before the children under it are read, so the walk
 * cannot be outrun downwards; resume runs it backwards. `root` itself is included even when the system
 * did not report it, so a tree that ended between the walk and now is simply a no-op rather than a gap.
 *
 * ponytail: a child started in the moment between the walk and the suspend is missed — the window is
 * one PowerShell call wide. Close it with a job object (a real freeze of the whole job) if an agent
 * ever turns out to spawn fast enough to slip through.
 */
export function treeOf(rows: { pid: number; ppid: number; born?: number }[], root: number): number[] {
  if (!root) return []
  const kids = new Map<number, number[]>()
  const born = new Map(rows.filter((r) => r.born !== undefined).map((r) => [r.pid, r.born!]))
  for (const r of rows) {
    if (!r.pid || r.pid === r.ppid) continue
    // Windows never clears a parent id when the parent ends, and reuses pids soon: a process whose
    // long-gone parent had a pid that now belongs to one in this tree is not its child. A child is
    // never older than its parent, so one that is was someone else's.
    const self = born.get(r.pid)
    const parent = born.get(r.ppid)
    if (self !== undefined && parent !== undefined && self < parent) continue
    const there = kids.get(r.ppid)
    if (there) there.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  const out: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()
    if (pid === undefined || seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  return out
}

/**
 * PROCESS_SUSPEND_RESUME only: the handle this opens can do nothing to a process but freeze and thaw
 * it. The walk and the calls are one script, so a pause is one process start rather than one per
 * process in the tree.
 */
const PS_SUSPEND = `param([Parameter(Mandatory=$true)][int]$Root, [Parameter(Mandatory=$true)][ValidateSet('suspend','resume')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FbFreeze {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  public const int SUSPEND_RESUME = 0x0800;
}
'@
# parents before children, so a process cannot start one behind the walk; the other way to thaw
# a child is never older than its parent: Windows keeps a dead parent's id on its children and reuses
# pids, so one older than the process now holding its parent's pid is not in this tree (treeOf)
$rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; born = $_.CreationDate } }
$born = @{}
foreach ($r in $rows) { if ($r.born) { $born[$r.pid] = $r.born } }
$kids = @{}
foreach ($r in $rows) {
  if (-not $r.pid -or $r.pid -eq $r.ppid) { continue }
  if ($born.ContainsKey($r.pid) -and $born.ContainsKey($r.ppid) -and $born[$r.pid] -lt $born[$r.ppid]) { continue }
  if (-not $kids.ContainsKey($r.ppid)) { $kids[$r.ppid] = @() }
  $kids[$r.ppid] += $r.pid
}
$order = @()
$seen = @{}
$queue = [System.Collections.Queue]::new()
$queue.Enqueue($Root)
while ($queue.Count -gt 0) {
  $pid1 = $queue.Dequeue()
  if ($seen.ContainsKey($pid1)) { continue }
  $seen[$pid1] = $true
  $order += $pid1
  if ($kids.ContainsKey($pid1)) { foreach ($k in $kids[$pid1]) { $queue.Enqueue($k) } }
}
if ($Action -eq 'resume') { [array]::Reverse($order) }
foreach ($target in $order) {
  $h = [FbFreeze]::OpenProcess([FbFreeze]::SUSPEND_RESUME, $false, $target)
  if ($h -eq [IntPtr]::Zero) { continue }   # it ended, or it is not ours to freeze
  try { if ($Action -eq 'suspend') { [void][FbFreeze]::NtSuspendProcess($h) } else { [void][FbFreeze]::NtResumeProcess($h) } }
  finally { [void][FbFreeze]::CloseHandle($h) }
}
`

const scriptPath = () => path.join(dirs.hooks, 'fb-suspend.ps1')

let written = false
function ensureScript(): string {
  const p = scriptPath()
  if (!written) {
    fs.mkdirSync(dirs.hooks, { recursive: true })
    fs.writeFileSync(p, PS_SUSPEND)
    written = true
  }
  return p
}

/** per console root: the freeze or thaw in flight, which the next one waits for */
const queued = new Map<number, Promise<void>>()

/**
 * Freeze or thaw a console's process tree, after whatever was asked of it before.
 *
 * Each call is a PowerShell start that compiles the P/Invoke first, a few hundred milliseconds, and
 * they used to run side by side: Pause then Resume (or Pause all, Resume all) in quick succession let
 * the resume finish first — a no-op on a tree not frozen yet — and then the suspend landed, leaving an
 * agent frozen while its tile said it was running. In order, the last one asked is the one that holds.
 * Errors are dropped like `killTree`'s: a process that ended while it was asked about has nothing to say.
 */
export function suspendTree(pid: number | undefined, action: 'suspend' | 'resume'): Promise<void> {
  if (!pid) return Promise.resolve()
  const run = () =>
    new Promise<void>((resolve) => {
      try {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-Root', String(pid), '-Action', action], { windowsHide: true, timeout: 20_000 }, () => resolve())
      } catch {
        resolve() // gone, or no PowerShell: the tile stays as it was
      }
    })
  const next = (queued.get(pid) ?? Promise.resolve()).then(run)
  queued.set(pid, next)
  void next.then(() => {
    if (queued.get(pid) === next) queued.delete(pid)
  })
  return next
}
