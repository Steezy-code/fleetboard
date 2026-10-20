// HTML from repos and models is rendered in the app window, whose scripts can reach window.fb
// (consoles, files). The sanitizer must stop every way of running script, checked in Chromium itself:
// each vector is rendered, every link clicked, every element given a chance to fire.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { App } from './harness'

let app: App
before(async () => {
  app = await App.launch()
})
after(async () => {
  await app?.close()
})

const VECTORS = [
  '<a href="javascript:window.__pwned=1">plain</a>',
  '<a href="java&#9;script:window.__pwned=2">tab</a>',
  '<a href="java&#10;script:window.__pwned=3">newline</a>',
  '<a href="&#1;javascript:window.__pwned=4">leading control char</a>',
  '<a href=" JaVaScRiPt:window.__pwned=5">case and space</a>',
  '<a href="javascript&colon;window.__pwned=6">entity colon</a>',
  '<a href="vbscript:window.__pwned=7">vbscript</a>',
  '<a href="data:text/html,<script>parent.__pwned=8</script>">data html</a>',
  '<img src=x onerror="window.__pwned=9">',
  '<img src="java&#9;script:window.__pwned=10">',
  '<svg onload="window.__pwned=11"></svg>',
  '<details open ontoggle="window.__pwned=12"><summary>x</summary></details>',
  '<div style="background:url(javascript:window.__pwned=13)">style</div>',
  '<iframe srcdoc="<script>parent.__pwned=14</script>"></iframe>',
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=15">',
  '<form action="javascript:window.__pwned=16"><button>go</button></form>',
  '<a href="#" onclick="window.__pwned=17">onclick</a>',
  '<input type="checkbox" onfocus="window.__pwned=18" autofocus>',
  '<a href="fbfile:///etc/passwd">fbfile link</a>',
  '<noscript><p title="</noscript><img src=x onerror=window.__pwned=19>">',
  '[md link](javascript:window.__pwned=20)',
  '[md tab](java\tscript:window.__pwned=21)',
  '<a href="java\u0000script:window.__pwned=22">nul</a>',
  // A streamed brief is re-rendered on every chunk, so the sanitizer also sees half-written markup.
  // These are the vectors above cut mid-tag, the way an agent's output arrives.
  '<img src=x onerror="window.__pwned=23"',
  '<img src=x onerror="window.__pwned=24',
  '<svg onload="window.__pwned=25"',
  '<iframe srcdoc="<script>parent.__pwned=26</scr',
  '<a href="javascript:window.__pwned=27',
  '<details open ontoggle="window.__pwned=28"><summary>x'
]

test('no vector runs script, in markdown or raw HTML, even when its links are clicked', async () => {
  const result = await app.eval(async (vectors) => {
    const fb = (window as any).__fleetboard.markdown
    const host = document.createElement('div')
    document.body.appendChild(host)
    const out: { vector: string; html: string; hrefs: string[]; handlers: string[]; tags: string[] }[] = []
    for (const v of vectors) {
      for (const html of [fb.renderMarkdown(v), fb.sanitizeHtml(v), fb.renderDocMarkdown(v)]) {
        host.innerHTML = html
        const hrefs = [...host.querySelectorAll('a')].map((a) => a.href)
        const handlers = [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name) || a.name === 'style' || a.name === 'srcdoc').map((a) => `${el.tagName}.${a.name}`))
        const tags = [...host.querySelectorAll('script,iframe,svg,math,form,style,object,embed,base,meta,link')].map((el) => el.tagName)
        // click like a user (no app handler in between, as in the Handoff and Sweep panels)
        for (const a of host.querySelectorAll('a')) (a as HTMLAnchorElement).click()
        out.push({ vector: v, html, hrefs, handlers, tags })
      }
    }
    await new Promise((r) => setTimeout(r, 500))
    host.remove()
    return { pwned: (window as any).__pwned ?? null, out }
  }, VECTORS)
  const bad = result.out.filter((r) => r.hrefs.some((h) => !/^(https?:|mailto:|file:|#|$)/.test(h)) || r.handlers.length || r.tags.length)
  assert.deepEqual(bad, [], 'sanitized output')
  assert.equal(result.pwned, null, 'no script ran')
  assert.equal(await app.eval(() => location.protocol), 'file:', 'the app page did not navigate away')
})

test('ordinary markdown survives sanitizing', async () => {
  const html = await app.eval(() => (window as any).__fleetboard.markdown.renderMarkdown('# Title\n\nSee [docs](https://example.com) and [a file](src/a.ts), `code`, **bold**.\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![img](https://example.com/x.png)'))
  for (const want of ['<h1 id="title">Title</h1>', 'href="https://example.com"', 'href="src/a.ts"', '<code>code</code>', '<strong>bold</strong>', 'type="checkbox"', '<table>', 'src="https://example.com/x.png"']) assert.ok(html.includes(want), `${want} in ${html}`)
})

test('the Documents studio keeps its callouts', async () => {
  const html = await app.eval(() => (window as any).__fleetboard.markdown.renderDocMarkdown('> **Note** this matters\n\n# Doc'))
  assert.match(html, /<blockquote class="callout callout-note">/)
})

test('a brief rendered chunk by chunk, as it streams, never runs script', async () => {
  // the Handoff and Sweep panels re-render on every chunk from the agent, so every prefix of a
  // hostile brief reaches the sanitizer — not just the finished text
  const brief = 'Summary of the session\n\n- did a thing\n\n<img src=x onerror="window.__pwned=101">\n\nmore <svg onload="window.__pwned=102"></svg> text\n'
  const result = await app.eval(async (text) => {
    const fb = (window as any).__fleetboard.markdown
    const host = document.createElement('div')
    document.body.appendChild(host)
    const bad: { at: number; html: string }[] = []
    for (let i = 1; i <= text.length; i++) {
      const html = fb.renderMarkdown(text.slice(0, i))
      host.innerHTML = html
      const handlers = [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name) || a.name === 'srcdoc').map((a) => a.name))
      const tags = [...host.querySelectorAll('script,iframe,svg,math,object,embed')].map((el) => el.tagName)
      if (handlers.length || tags.length) bad.push({ at: i, html })
    }
    await new Promise((r) => setTimeout(r, 300))
    host.remove()
    return { bad, pwned: (window as any).__pwned ?? null }
  }, brief)
  assert.deepEqual(result.bad, [], 'a prefix of the brief rendered live markup')
  assert.equal(result.pwned, null, 'no script ran while the brief streamed')
})
