// A minimal OpenAI Responses API (streaming) for driving the real Codex CLI in tests. Each reply says
// how the conversation began, so a test can tell which conversation a resumed console picked up.
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
      const id = `resp_${++n}`
      const text = `Conversation started with: ${user[0] ?? '(nothing)'}`
      const item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      const sse = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      sse('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      sse('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text })
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
