import { spawn, type ChildProcess } from 'node:child_process'
import type { CliRunRequest } from '@shared/types'
import { agentById, readOnlyAgent } from '@shared/agents'
import type { MainContext } from './context'
import { loginEnv, which } from './env'
import { profileEnv } from './profiles'
import { stripAnsi } from './pty'
import { IS_WIN, killTree, launch, launchOptions } from './platform'

// Headless one-shot runs of the user's own CLIs. Powers the planner, studios, memory scans,
// handoff summaries and loop goal checks, on the subscription the CLI is already logged into.

const runs = new Map<string, ChildProcess>()
/** Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN); stay well under it. */
export const MAX_ARG_PROMPT = 100_000
/**
 * The most of one run's output to hold. A reply is a plan, a document or a verdict — kilobytes. A
 * CLI that streams a build log instead used to be kept whole, twice (the text and the renderer's own
 * copy), so a runaway run pinned hundreds of megabytes in the main process. Past this the text stops
 * growing and says so, which makes a JSON reply fail to parse rather than parse to something wrong.
 */
const MAX_TEXT = 4 * 1024 * 1024
/** the longest a headless run may take: the longest of them (a document, a brainstorm seat) finish well inside it */
export const RUN_TIMEOUT_MS = 20 * 60_000
/** stderr is only ever shown as a tail. */
const MAX_ERR = 64 * 1024
/**
 * A headless run reads console output, PR comments and repositories, any of which can carry
 * instructions, so it gets these tools and no others. The set is restricted rather than allowed:
 * allow rules add to the user's own settings, where Bash(curl:*), Edit or an MCP server may already
 * be allowed. No Bash at all, since even git log writes files (--output=).
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob'

export function register(ctx: MainContext) {
  ctx.ipc.handle('cli:run', async (_e, req: CliRunRequest) => {
    const settings = ctx.settings()
    // a run that names no agent is one of the planner's, which reads untrusted text: never a CLI that may write
    const agentId = req.agentId ?? readOnlyAgent(settings.plannerAgent)
    const agent = agentById(agentId, settings.customAgents)
    if (!agent?.headless) throw new Error(`${agent?.name ?? agentId} has no headless mode`)
    const bin = await which(agent.bin)
    if (!bin) throw new Error(`${agent.name} (${agent.bin}) is not on your PATH`)

    let args: string[]
    const isClaude = agent.id === 'claude'
    // Claude reads the prompt from stdin: prompts with whole console logs can exceed what argv holds
    if (isClaude) {
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
      if (req.model) args.push('--model', req.model)
      // the mode too, or a defaultMode of bypass in the user's settings would apply; and no MCP servers
      args.push('--permission-mode', 'default', '--tools', READ_ONLY_TOOLS, '--strict-mcp-config')
    } else {
      if (req.prompt.length > MAX_ARG_PROMPT) {
        const msg = `[This prompt is ${Math.round(req.prompt.length / 1000)} KB, too long to pass to ${agent.name} on its command line. Use Claude Code for it, or include less.]`
        ctx.emit('cli:chunk', req.runId, msg)
        return { code: 1, text: msg }
      }
      args = agent.headless(req.prompt)
    }

    const env = { ...(await loginEnv()), ...profileEnv(agent.id, req.profileId) }
    return new Promise<{ code: number; text: string }>((resolve) => {
      let child: ChildProcess
      try {
        const l = launch(bin, args, env)
        child = spawn(l.file, l.args, { cwd: req.cwd, env, stdio: [isClaude ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...launchOptions(l) })
      } catch (e) {
        return resolve({ code: 1, text: String(e) })
      }
      runs.set(req.runId, child)
      // A headless run ends: a stuck one (a CLI waiting on a login prompt, a model call that never
      // returns) used to hold its caller — the planner, a loop's judge, a handoff — for good. Ended as
      // a cancel is, so it reports as unfinished.
      const ceiling = setTimeout(() => {
        ctx.emit('cli:chunk', req.runId, `\n[Fleetboard stopped this run after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes.]`)
        kill(req.runId)
      }, RUN_TIMEOUT_MS)
      ceiling.unref?.()
      child.on('exit', () => clearTimeout(ceiling))
      if (isClaude) {
        // a CLI that exits before reading all of it closes the pipe: that is not our error
        child.stdin!.on('error', () => {})
        child.stdin!.end(req.prompt)
      }
      let text = ''
      let pending = ''
      let finalResult: string | null = null
      // Claude Code exits 0 after a run that ended in an error (max turns, an API error): its result says so
      let failed = false
      let truncated = false
      const push = (chunk: string) => {
        if (!chunk) return
        if (text.length + chunk.length > MAX_TEXT) {
          if (!truncated) {
            truncated = true
            text += `\n[Fleetboard stopped keeping this run's output at ${Math.round(MAX_TEXT / 1_000_000)} MB.]\n`
          }
        } else text += chunk
        ctx.emit('cli:chunk', req.runId, chunk)
      }
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (d: string) => {
        if (!isClaude) return push(stripAnsi(d))
        pending += d
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (!line) continue
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
              push(ev.event.delta.text)
            } else if (ev.type === 'stream_event' && ev.event?.type === 'message_start' && text && !text.endsWith('\n')) {
              push('\n\n')
            } else if (ev.type === 'result') {
              finalResult = typeof ev.result === 'string' ? ev.result : null
              failed = ev.is_error === true
            } else if (ev.type === 'assistant' && ev.message?.content) {
              for (const c of ev.message.content) if (c.type === 'tool_use') ctx.emit('cli:activity', req.runId, `${c.name} ${summarizeInput(c.input)}`)
            }
          } catch {
            /* partial or non-JSON line */
          }
        }
      })
      let err = ''
      child.stderr!.on('data', (d) => (err = (err + d.toString()).slice(-MAX_ERR)))
      child.on('close', (code, signal) => {
        runs.delete(req.runId)
        const out = finalResult ?? text
        if (code && !out) ctx.emit('cli:chunk', req.runId, `\n[${agent.name} exited ${code}] ${stripAnsi(err).slice(-600)}`)
        // Not finished: killed by a signal (a crash, the OOM killer, a cancel, whose caller has gone), a
        // result that says it failed, or a Claude stream that ended before its result. Callers save
        // what a finished run returns, a document over the last good one among them.
        const unfinished = code === null || !!signal || failed || (isClaude && finalResult === null)
        resolve({ code: code || (unfinished ? 1 : 0), text: out || stripAnsi(err) })
      })
      child.on('error', (e) => {
        runs.delete(req.runId)
        resolve({ code: 1, text: String(e) })
      })
    })
  })

  ctx.ipc.handle('cli:cancel', (_e, runId: string) => kill(runId))
}

function kill(runId: string) {
  const child = runs.get(runId)
  // Windows: the CLI may run under node or cmd.exe; end the whole tree
  if (IS_WIN) killTree(child?.pid)
  else child?.kill('SIGTERM')
  runs.delete(runId)
}

/**
 * End every headless run. Called when the app quits: these were only ever reachable through
 * cli:cancel, so a planner or studio run left behind kept going — and kept spending tokens — with
 * its output going nowhere.
 */
export function killRuns() {
  // eslint-disable-next-line unicorn/no-useless-spread -- a copy, because kill() deletes from runs
  for (const runId of [...runs.keys()]) kill(runId)
}

function summarizeInput(input: any): string {
  if (!input) return ''
  return String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? '').slice(0, 80)
}
