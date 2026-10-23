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
export function treeOf(rows: { pid: number; ppid: number }[], root: number): number[] {
  if (!root) return []
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    if (!r.pid || r.pid === r.ppid) continue
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
$rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId } }
$kids = @{}
foreach ($r in $rows) { if ($r.pid -and $r.pid -ne $r.ppid) { if (-not $kids.ContainsKey($r.ppid)) { $kids[$r.ppid] = @() }; $kids[$r.ppid] += $r.pid } }
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

/**
 * Freeze or thaw a console's process tree. Fire and forget, like `killTree`: a pause the user can see
 * on the tile either took or the process is gone, and there is nothing useful to do with an error from
 * a process that ended while we asked about it.
 *
 * ponytail: PowerShell compiles the P/Invoke on every call, so this costs a few hundred milliseconds.
 * Fine for a button; batch the pids into one call if "Pause all" on a full board ever feels slow.
 */
export function suspendTree(pid: number | undefined, action: 'suspend' | 'resume') {
  if (!pid) return
  try {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-Root', String(pid), '-Action', action], { windowsHide: true, timeout: 20_000 }, () => {})
  } catch {
    /* gone, or no PowerShell: the tile stays as it was */
  }
}
