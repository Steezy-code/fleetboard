// Antigravity's public stream-json protocol. Only assistant text reaches callers: metadata,
// user prompts and tool payloads must never become a planner's JSON reply.
type Event = { kind: 'text' | 'activity'; text: string } | { kind: 'result'; text: string; ok: boolean }
export function antigravityEvent(line: string): Event | null {
  let ev: any
  try { ev = JSON.parse(line) } catch { return null }
  if (ev?.event === 'step_update') {
    const step = ev.step_update
    if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') return { kind: 'text', text: step.text_delta }
    if (step?.step_type === 'tool_call' && step.state === 'RUNNING') return { kind: 'activity', text: String(step.tool_name ?? 'Using a tool').slice(0, 100) }
  }
  if (ev?.event === 'result') {
    const r = ev.result
    if (!r || typeof r.status !== 'string') return null
    const ok = r.status === 'SUCCESS' && typeof r.response === 'string'
    return { kind: 'result', ok, text: typeof r.response === 'string' && r.response ? r.response : typeof r.error === 'string' ? r.error : '' }
  }
  return null
}
