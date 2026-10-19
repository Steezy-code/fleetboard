// A minimal OpenAI Responses API (streaming) for driving the real Codex CLI in tests. Each reply says
// how the conversation began, so a test can tell which conversation a resumed console picked up.
// "run the command `X`" makes it ask Codex to run X outside the sandbox, which Codex asks the user
// to approve; once the command's output is back it replies "Done, the command ran." (or was refused).
// A Fleetboard worker brief ("Task from …: … You own: a.txt.") makes it act as a worker: write the file
// it owns (inside the sandbox), then report through the fleet's MCP tool.
import fs from 'node:fs'
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
  /** per request: what the user said first and last, the tools offered, and tools found by tool search */
  const requests: { first?: string; last?: string; tools: string[]; found: string[] }[] = []
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
      if (process.env.MOCK_DUMP) fs.appendFileSync(process.env.MOCK_DUMP, body + '\n')
      const user = said(j.input)
      const tools: string[] = (j.tools ?? []).map((t: any) => t?.name ?? t?.type).filter(Boolean)
      const input: any[] = j.input ?? []
      // tools found by a tool search (Codex lists MCP tools that way), as namespace/name
      const allFound: string[] = input
        .filter((i) => i?.type === 'tool_search_output')
        .flatMap((i) => (i.tools ?? []).flatMap((t: any) => (t?.type === 'namespace' ? (t.tools ?? []).map((x: any) => `${t.name}/${x.name}`) : [t?.name])))
      requests.push({ first: user[0], last: user.at(-1), tools, found: allFound })
      const lastUser = input.map((i, at) => ({ i, at })).filter(({ i }) => i?.type === 'message' && i.role === 'user' && !/^\s*</.test(textOf(i.content))).at(-1)
      const lastText = lastUser ? textOf(lastUser.i.content) : ''
      const results = input.slice((lastUser?.at ?? 0) + 1).filter((i) => i?.type === 'function_call_output')
      const result = results[0]
      let command = /run the command `([^`]+)`/i.exec(lastText)?.[1]
      let call: { name: string; args: object } | undefined
      let search: string | undefined
      const owns = /Task from .+? You own: (.+?)\.(?:\s|$)/.exec(lastText)?.[1]?.split(',')[0]?.trim()
      if (owns) {
        // a worker: write the file it owns, then report
        // like a model in Codex: MCP tools are not listed up front, a tool search brings them in
        const found = input
          .slice((lastUser?.at ?? 0) + 1)
          .filter((i) => i?.type === 'tool_search_output')
          .flatMap((i) => (i.tools ?? []).flatMap((t: any) => (t?.type === 'namespace' ? (t.tools ?? []).map((x: any) => `${t.name}/${x.name}`) : [t?.name])))
        const report = [...tools, ...found].find((t) => /fleet_report$/.test(t ?? ''))
        const searched = input.slice((lastUser?.at ?? 0) + 1).some((i) => i?.type === 'tool_search_output')
        if (results.length === 0) call = { name: 'exec_command', args: { cmd: `printf 'Codex was here\\n' > ${owns}` } }
        else if (results.length === 1 && report) call = { name: report, args: { status: 'done', summary: `Wrote ${owns}.` } }
        else if (results.length === 1 && !searched && tools.includes('tool_search')) search = 'fleet_report'
        command = undefined
      } else if (command && !result) call = { name: 'exec_command', args: { cmd: command, sandbox_permissions: 'require_escalated', justification: 'Do you want me to run this?' } }
      const id = `resp_${++n}`
      const sse = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      let item: any
      if (search) {
        item = { type: 'tool_search_call', id: `ts_${n}`, call_id: `call_${n}`, execution: 'client', arguments: { query: search }, status: 'completed' }
        sse('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } })
      } else if (call) {
        const args = JSON.stringify(call.args)
        // a tool found by tool search lives in a namespace (mcp__<server>), given apart from its name
        const [namespace, name] = call.name.includes('/') ? call.name.split('/') : [undefined, call.name]
        item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, ...(namespace ? { namespace } : {}), arguments: args, status: 'completed' }
        sse('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
        sse('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: args })
        sse('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: args })
      } else {
        const text = owns ? 'Reported to the lead.' : result ? 'Done, the command ran (or was refused).' : `Conversation started with: ${user[0] ?? '(nothing)'}`
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
  const requests: { first?: string; last?: string; tools: string[] }[] = []
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
      if (process.env.MOCK_DUMP) fs.appendFileSync(process.env.MOCK_DUMP, body + '\n')
      const contents: any[] = j.contents ?? []
      const user = contents
        .filter((c: any) => c.role === 'user')
        .flatMap((c: any) => (c.parts ?? []).map((p: any) => p.text ?? ''))
        .filter((t: string) => t && !/^\s*</.test(t))
      const tools: string[] = (j.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => f.name))
      requests.push({ first: user[0], last: user.at(-1), tools })
      // a Fleetboard worker brief: write the file it owns, report through the fleet's MCP tool, done
      const briefAt = contents.findLastIndex((c: any) => c.role === 'user' && (c.parts ?? []).some((p: any) => /Task from .+ You own: /.test(p.text ?? '')))
      const owns = briefAt >= 0 ? /You own: (.+?)\.(?:\s|$)/.exec(contents[briefAt].parts.map((p: any) => p.text ?? '').join(' '))?.[1]?.split(',')[0]?.trim() : undefined
      const answered = briefAt >= 0 ? contents.slice(briefAt + 1).flatMap((c: any) => (c.parts ?? []).filter((p: any) => p.functionResponse)).length : 0
      const report = tools.find((t) => /fleet_report$/.test(t))
      let part: object = { text: `Conversation started with: ${user[0] ?? '(nothing)'}` }
      if (owns && answered === 0) part = { functionCall: { name: 'write_file', args: { file_path: owns, content: 'Gemini was here\n' } } }
      else if (owns && answered === 1 && report) part = { functionCall: { name: report, args: { status: 'done', summary: `Wrote ${owns}.` } } }
      else if (owns) part = { text: 'Reported to the lead.' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], usageMetadata })}\n\n`)
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
