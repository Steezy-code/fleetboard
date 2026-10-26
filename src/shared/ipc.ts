// Explicit IPC surface. New handlers must be added here; unit tests enforce coverage.
export const INVOKE_CHANNELS = [
  "agents:detect",
  "app:crashRecovered",
  "app:idleSeconds",
  "app:paths",
  "app:quit",
  "ci:failedLog",
  "ci:prFeedback",
  "ci:status",
  "cli:cancel",
  "cli:run",
  "dialog:openFile",
  "dialog:openFolder",
  "dialog:saveFile",
  "fleet:ack",
  "fleet:answer",
  "fleet:checkOff",
  "fleet:diff",
  "fleet:discard",
  "fleet:done",
  "fleet:fromGitHub",
  "fleet:isolation",
  "fleet:mergeReady",
  "fleet:openPr",
  "fleet:revertMerge",
  "fleet:runCheck",
  "fleet:startLead",
  "fleet:state",
  "fleet:verifyReady",
  "fleet:userMessage",
  "fs:exists",
  "fs:mkdir",
  "fs:read",
  "fs:stat",
  "fs:tree",
  "fs:write",
  "fs:writeBase64",
  "git:branches",
  "git:checkout",
  "git:commit",
  "git:diff",
  "git:fetch",
  "git:init",
  "git:isRepo",
  "git:log",
  "git:prList",
  "git:pull",
  "git:push",
  "git:remote",
  "git:show",
  "git:status",
  "goal:check",
  "journal:append",
  "journal:dir",
  "journal:read",
  "knowledge:read",
  "pdf:fromHtml",
  "profiles:create",
  "profiles:default",
  "profiles:delete",
  "profiles:list",
  "profiles:open",
  "profiles:rename",
  "profiles:saveCurrent",
  "pty:answer",
  "pty:answerByRule",
  "pty:buffer",
  "pty:deliver",
  "pty:info",
  "pty:kill",
  "pty:list",
  "pty:pause",
  "pty:prompt",
  "pty:resume",
  "pty:ruleFingerprint",
  "pty:spawn",
  "pty:tail",
  "recovery:apply",
  "recovery:export",
  "recovery:import",
  "recovery:list",
  "recovery:preview",
  "remote:disable",
  "remote:enable",
  "remote:reset",
  "remote:status",
  "shell:openExternal",
  "shell:openPath",
  "shell:showItem",
  "skills:create",
  "skills:delete",
  "skills:list",
  "skills:open",
  "skills:read",
  "skills:save",
  "starter:goals",
  "store:forgetProject",
  "store:getGlobal",
  "store:loadProject",
  "store:projectId",
  "store:projects",
  "store:recoveries",
  "store:saveProject",
  "store:setGlobal",
  "store:setSettings",
  "store:settings",
  "sweep:last",
  "sweep:repos",
  "sweep:run",
  "update:check",
  "usage:limits",
  "usage:spentIn",
  "usage:tokens",
  "webview:devtools",
  "win:close",
  "win:maximize",
  "win:minimize",
] as const
export const SEND_CHANNELS = [
  "app:background",
  "app:logError",
  "app:quitAck",
  "fs:grantDropped",
  "pty:paste",
  "pty:resize",
  "pty:write",
] as const
export const EVENT_CHANNELS = [
  "app:background",
  "app:confirmQuit",
  "app:error",
  "app:logError",
  "app:notice",
  "app:quitAck",
  "app:saveAndQuit",
  "cli:activity",
  "cli:chunk",
  "fleet:addConsole",
  "fleet:asked",
  "fleet:plan",
  "fleet:ready",
  "fleet:removeConsoles",
  "fleet:state",
  "fleet:traffic",
  "fleet:trouble",
  "fs:grantDropped",
  "pty:activity",
  "pty:data",
  "pty:exit",
  "pty:held",
  "pty:lostSession",
  "pty:paste",
  "pty:resize",
  "pty:session",
  "pty:status",
  "pty:write",
  "remote:changed",
  "remote:status",
  "store:recovered",
  "sweep:progress",
  "usage:progress",
  "usage:updated",
] as const

export type InvokeChannel = typeof INVOKE_CHANNELS[number]
export type SendChannel = typeof SEND_CHANNELS[number]
const inbound = new Set<string>([...INVOKE_CHANNELS, ...SEND_CHANNELS])
const str = (v: unknown) => typeof v === 'string' && v.length <= 2_000_000
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

const stringFirst = new Set(['store:projectId', 'store:loadProject', 'store:forgetProject', 'store:getGlobal', 'fs:read', 'fs:tree', 'fs:exists', 'fs:mkdir', 'fs:stat', 'fs:grantDropped', 'shell:openExternal', 'shell:openPath', 'shell:showItem', 'cli:cancel', 'pty:kill', 'pty:pause', 'pty:resume', 'pty:buffer', 'pty:tail', 'pty:prompt', 'pty:info', 'pty:ruleFingerprint', 'fleet:state', 'fleet:isolation', 'fleet:diff', 'fleet:discard', 'fleet:done', 'fleet:openPr', 'fleet:mergeReady', 'fleet:revertMerge', 'fleet:runCheck', 'fleet:checkOff', 'ci:status', 'ci:failedLog', 'ci:prFeedback', 'git:isRepo', 'git:init', 'git:status', 'git:diff', 'git:show', 'git:commit', 'git:log', 'git:push', 'git:pull', 'git:fetch', 'git:branches', 'git:checkout', 'git:remote', 'git:prList'])

/** Validate high-privilege requests before touching a process, filesystem or shell. */
export function validateIpc(channel: string, args: unknown[]): void {
  if (!inbound.has(channel)) throw new Error(`Unknown IPC channel: ${channel}`)
  if (stringFirst.has(channel) && !str(args[0])) throw new Error(`Invalid arguments for ${channel}`)
  const [a, b, c, d, e] = args
  let ok = args.length <= 8
  switch (channel) {
    case 'pty:spawn': ok &&= obj(a) && str(a.id) && str(a.agentId) && str(a.cwd); break
    case 'pty:write': case 'pty:deliver': case 'fs:writeBase64': case 'goal:check':
    case 'fleet:verifyReady': case 'fleet:userMessage': case 'fleet:fromGitHub': case 'fleet:answer':
    case 'pdf:fromHtml': ok &&= str(a) && str(b); break
    case 'pty:paste': ok &&= str(a) && str(b) && typeof c === 'boolean'; break
    case 'pty:resize': ok &&= str(a) && finite(b) && finite(c) && Number(b) >= 2 && Number(c) >= 1 && Number(b) <= 2000 && Number(c) <= 2000; break
    case 'fs:write': ok &&= str(a) && str(b) && (c === undefined || (obj(c) && (c.base === undefined || c.base === null || str(c.base)))); break
    case 'cli:run': ok &&= obj(a) && str(a.runId) && str(a.prompt) && str(a.cwd); break
    case 'fleet:startLead': ok &&= obj(a) && str(a.projectId) && str(a.projectPath) && str(a.goal); break
    case 'store:saveProject': ok &&= obj(a) && str(a.id) && str(a.path) && Array.isArray(a.workspaces); break
    case 'recovery:apply': case 'recovery:preview': ok &&= str(a) && args.length === 1; break
    case 'store:setSettings': ok &&= obj(a); break
    case 'store:setGlobal': ok &&= str(a) && !['__proto__', 'constructor', 'prototype'].includes(String(a)); break
    case 'remote:enable': ok &&= ['tailscale', 'lan', 'local'].includes(String(a)); break
    case 'pty:answer': case 'pty:answerByRule': ok &&= str(a) && obj(b) && (str(b.option) || typeof b.yes === 'boolean' || b.enter === true) && (b.seen === undefined || str(b.seen)) && (channel !== 'pty:answerByRule' || (str(c) && str(d) && str(e))); break
  }
  if (!ok) throw new Error(`Invalid arguments for ${channel}`)
}
