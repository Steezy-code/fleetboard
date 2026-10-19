import { spawn, type ChildProcess } from 'node:child_process'
import type { CliRunRequest } from '@shared/types'
import { agentById } from '@shared/agents'
import type { MainContext } from './context'
import { loginEnv, which } from './env'
import { profileEnv } from './profiles'
import { stripAnsi } from './pty'

// Headless one-shot runs of the user's own CLIs. Powers the planner, studios, memory scans,
// handoff summaries and loop goal checks, on the subscription the CLI is already logged into.

const runs = new Map<string, ChildProcess>()
/** Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN); stay well under it. */
export const MAX_ARG_PROMPT = 100_000
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Bash(git log:*)', 'Bash(git ls-files:*)', 'Bash(git status:*)']

export function register(ctx: MainContext) {
  ctx.ipc.handle('cli:run', async (_e, req: CliRunRequest) => {
    const settings = ctx.settings()
    const agentId = req.agentId ?? settings.plannerAgent ?? 'claude'
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
      if (req.allowTools) args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', ...READ_ONLY_TOOLS, 'Edit', 'Write')
      else args.push('--allowedTools', ...READ_ONLY_TOOLS)
    } else {
      if (req.prompt.length > MAX_ARG_PROMPT) {
        const msg = `[This prompt is ${Math.round(req.prompt.length / 1000)} KB, too long to pass to ${agent.name} on its command line. Use Claude Code for it, or include less.]`
        ctx.emit('cli:chunk', req.runId, msg)
        ctx.emit('cli:done', req.runId, 1)
        return { code: 1, text: msg }
      }
      args = agent.headless(req.prompt)
    }

    const env = { ...(await loginEnv()), ...profileEnv(agent.id, req.profileId) }
    return new Promise<{ code: number; text: string }>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(bin, args, { cwd: req.cwd, env, stdio: [isClaude ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
      } catch (e) {
        ctx.emit('cli:done', req.runId, 1)
        return resolve({ code: 1, text: String(e) })
      }
      runs.set(req.runId, child)
      if (isClaude) {
        // a CLI that exits before reading all of it closes the pipe: that is not our error
        child.stdin!.on('error', () => {})
        child.stdin!.end(req.prompt)
      }
      let text = ''
      let pending = ''
      let finalResult: string | null = null
      const push = (chunk: string) => {
        if (!chunk) return
        text += chunk
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
            } else if (ev.type === 'assistant' && ev.message?.content) {
              for (const c of ev.message.content) if (c.type === 'tool_use') ctx.emit('cli:activity', req.runId, `${c.name} ${summarizeInput(c.input)}`)
            }
          } catch {
            /* partial or non-JSON line */
          }
        }
      })
      let err = ''
      child.stderr!.on('data', (d) => (err += d.toString()))
      child.on('close', (code) => {
        runs.delete(req.runId)
        const out = finalResult ?? text
        if (code && !out) ctx.emit('cli:chunk', req.runId, `\n[${agent.name} exited ${code}] ${stripAnsi(err).slice(-600)}`)
        ctx.emit('cli:done', req.runId, code ?? 0)
        resolve({ code: code ?? 0, text: out || stripAnsi(err) })
      })
      child.on('error', (e) => {
        runs.delete(req.runId)
        resolve({ code: 1, text: String(e) })
      })
    })
  })

  ctx.ipc.handle('cli:cancel', (_e, runId: string) => {
    runs.get(runId)?.kill('SIGTERM')
    runs.delete(runId)
  })
}

function summarizeInput(input: any): string {
  if (!input) return ''
  return String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? '').slice(0, 80)
}
