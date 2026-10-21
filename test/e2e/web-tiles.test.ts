// Web tiles browse in their own session, and Electron grants whatever it is not told to refuse.
// A site gets nothing. A page on the machine the user controls — their own dev server, running what an
// agent last wrote — gets the microphone and notifications, and nothing else: not the camera, which
// the app refuses even to its own window, and not location.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { App, makeRepo, makeSandbox } from './harness'

let app: App
let server: http.Server
const reports: Record<string, Record<string, string>> = {}

before(async () => {
  // a page that asks for permissions and posts back what it got
  server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        const { host, results } = JSON.parse(b)
        reports[host] = results
        res.writeHead(204).end()
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><script>
      (async () => {
        const results = {}
        results.notifications = await Notification.requestPermission().catch((e) => 'error')
        results.geolocation = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r(e.code === 1 ? 'denied' : 'unavailable'), { timeout: 3000 }))
        results.camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => e.name)
        results.microphone = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name)
        fetch('/report', { method: 'POST', body: JSON.stringify({ host: location.hostname, results }) })
      })()
    </script>`)
  })
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', () => r()))
  const sb = makeSandbox()
  app = await App.launch({ sandbox: sb, extraArgs: ['--use-fake-device-for-media-stream'] })
  await app.openProject(makeRepo(sb))
})

after(async () => {
  await app?.close()
  server?.close()
})

test('a site in a web tile gets nothing; a dev server gets the microphone and no more', async () => {
  const port = (server.address() as any).port
  for (const [i, host] of ['127.0.0.2', 'localhost'].entries()) {
    await app.eval(({ url, i }) => (window as any).__fleetboard.useApp.getState().addNode({ type: 'web', x: 100 + i * 700, y: 100, w: 640, h: 480, data: { url } }), { url: `http://${host}:${port}/`, i })
  }
  await app.waitFor(() => reports['127.0.0.2'] && reports.localhost, { timeout: 20_000, label: 'both pages reported' })
  assert.equal(reports['127.0.0.2'].notifications, 'denied')
  assert.equal(reports['127.0.0.2'].geolocation, 'denied')
  assert.equal(reports['127.0.0.2'].camera, 'NotAllowedError')
  assert.equal(reports['127.0.0.2'].microphone, 'NotAllowedError')

  assert.equal(reports.localhost.notifications, 'granted')
  assert.equal(reports.localhost.microphone, 'granted', 'a dev server may record audio')
  assert.equal(reports.localhost.camera, 'NotAllowedError', 'and never the camera, however local it is')
  assert.equal(reports.localhost.geolocation, 'denied')
})
