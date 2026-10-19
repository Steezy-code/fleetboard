// A minimal OpenAI Responses API (streaming) for driving the real Codex CLI in tests. Each reply says
// how the conversation began, so a test can tell which conversation a resumed console picked up.
// "run the command `X`" makes it ask Codex to run X outside the sandbox, which Codex asks the user
// to approve; once the command's output is back it replies "Done, the command ran." (or was refused).
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const textOf = (content: any) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : String(content ?? ''))
const said = (input: any[]) =>
  (input ?? [])
    .filter((i) => i?.type === 'message' && i.role === 'user')
    .map((i) => textOf(i.content))
    .filter((t) => !/^\s*</.test(t))

export async function startMockResponses() {
  let n = 0
  const requests: { first?: string; last?: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      }
      let j: any = {}
      try {
        j = JSON.parse(body)
      } catch {
        /* empty */
      }
      const user = said(j.input)
      requests.push({ first: user[0], last: user.at(-1) })
      const input: any[] = j.input ?? []
      const lastUser = input.map((i, at) => ({ i, at })).filter(({ i }) => i?.type === 'message' && i.role === 'user' && !/^\s*</.test(textOf(i.content))).at(-1)
      const result = input.slice((lastUser?.at ?? 0) + 1).find((i) => i?.type === 'function_call_output')
      const command = /run the command `([^`]+)`/i.exec(lastUser ? textOf(lastUser.i.content) : '')?.[1]
      const id = `resp_${++n}`
      const sse = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      let item: any
      if (command && !result) {
        const args = JSON.stringify({ cmd: command, sandbox_permissions: 'require_escalated', justification: 'Do you want me to run this?' })
        item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: args, status: 'completed' }
        sse('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
        sse('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: args })
        sse('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: args })
      } else {
        const text = result ? 'Done, the command ran (or was refused).' : `Conversation started with: ${user[0] ?? '(nothing)'}`
        item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
        sse('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        sse('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text })
      }
      sse('response.output_item.done', { output_index: 0, item })
      sse('response.completed', {
        response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
      })
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        // Codex leaves a background app-server holding keep-alive connections open
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

/**
 * A minimal Gemini API (GOOGLE_GEMINI_BASE_URL) for the real Gemini CLI: streamed replies say how the
 * conversation began; the CLI's side requests (routing, next speaker) get the JSON they expect.
 */
export async function startMockGemini() {
  const requests: { first?: string; last?: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let j: any = {}
      try {
        j = JSON.parse(body)
      } catch {
        /* empty */
      }
      const url = req.url ?? ''
      const json = (o: object) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 }
      if (url.includes(':countTokens')) return json({ totalTokens: 10 })
      if (url.includes(':generateContent')) {
        const text = JSON.stringify({ next_speaker: 'user', reasoning: 'done', model_choice: 'flash', complexity: 'simple' })
        return json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata })
      }
      // what the user said: Gemini sends its own context (<session_context>…) as a part of the first turn
      const user = (j.contents ?? [])
        .filter((c: any) => c.role === 'user')
        .flatMap((c: any) => (c.parts ?? []).map((p: any) => p.text ?? ''))
        .filter((t: string) => t && !/^\s*</.test(t))
      requests.push({ first: user[0], last: user.at(-1) })
      const text = `Conversation started with: ${user[0] ?? '(nothing)'}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata })}\n\n`)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}
