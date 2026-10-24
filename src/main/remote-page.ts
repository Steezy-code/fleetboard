// The phone Inbox page (served by remote.ts). Plain DOM, no framework: everything from the server is
// set with textContent, never as HTML. The secret is read from the link's #fragment.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0f0d0c">
<title>Fleetboard Inbox</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><span class="dot"></span><b id="project">Fleetboard</b><span id="count" class="pill"></span></header>
<main id="main"><p class="muted">Connecting…</p></main>
<div id="sheet" class="sheet hidden"><div class="sheet-head"><b id="sheet-title"></b><button id="sheet-close" class="btn">Close</button></div><pre id="sheet-body"></pre></div>
<div id="toast" class="toast hidden"></div>
<script src="/app.js"></script>
</body>
</html>`

export const PAGE_CSS = `
:root { --bg: #0f0d0c; --card: #1a1715; --line: #2c2724; --text: #f2ede8; --muted: #a59d96; --accent: #ff4a2b; --ok: #3ecf8e; --warn: #f5b740; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 14px 16px; padding-top: max(14px, env(safe-area-inset-top)); background: rgba(15,13,12,.92); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); z-index: 2; }
header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
header b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 12px; padding: 2px 9px; border-radius: 99px; background: var(--accent); color: #fff; }
.pill:empty { display: none; }
main { padding: 12px 16px 40px; max-width: 640px; margin: 0 auto; }
h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 18px 2px 8px; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; margin-bottom: 10px; }
.card .who { font-size: 13px; color: var(--muted); margin-bottom: 4px; }
.card .who b { color: var(--text); }
.card .title { font-weight: 600; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; }
pre { margin: 0 0 10px; padding: 8px 10px; background: #0b0a09; border: 1px solid var(--line); border-radius: 8px; font: 12px/1.4 ui-monospace, "JetBrains Mono", monospace; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { appearance: none; border: 1px solid var(--line); background: #24201d; color: var(--text); border-radius: 10px; padding: 10px 14px; font: inherit; font-size: 14px; min-height: 42px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: .5; }
a.btn { display: inline-flex; align-items: center; text-decoration: none; }
.row { display: flex; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid var(--line); }
.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.st.working { color: var(--accent); border-color: var(--accent); }
.st.needs-you { color: var(--warn); border-color: var(--warn); }
.st.idle { color: var(--ok); border-color: var(--ok); }
.muted { color: var(--muted); }
.empty { text-align: center; color: var(--muted); padding: 40px 0; }
.sheet { position: fixed; inset: 0; background: var(--bg); z-index: 5; display: flex; flex-direction: column; padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); }
.sheet-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.sheet-head b { flex: 1; }
.sheet pre { flex: 1; max-height: none; margin: 0; }
.hidden { display: none !important; }
.toast { position: fixed; left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); background: #24201d; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; z-index: 6; }
.toast.bad { border-color: var(--warn); }
`

export const PAGE_JS = `'use strict'
;(function () {
  // the secret comes in the link's #fragment: kept for this tab only, and taken out of the address
  // bar, history and synced tabs, where it would outlive the visit
  var token = location.hash.slice(1)
  try {
    if (token) sessionStorage.setItem('fb.token', token)
    else token = sessionStorage.getItem('fb.token') || ''
  } catch (e) {}
  if (location.hash) history.replaceState(null, '', location.pathname)
  var main = document.getElementById('main')
  var busy = false
  var timer = null
  var dead = false

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = String(text)
    return e
  }
  function toast(text, bad) {
    var t = document.getElementById('toast')
    t.textContent = text
    t.className = 'toast' + (bad ? ' bad' : '')
    clearTimeout(toast.t)
    toast.t = setTimeout(function () { t.className = 'toast hidden' }, 3500)
  }
  function api(path, body) {
    var opts = { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }
    if (body) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) { j.httpStatus = r.status; return j })
    })
  }
  function button(label, cls, onClick) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label)
    b.addEventListener('click', function () {
      if (busy) return
      busy = true
      var all = main.querySelectorAll('button')
      for (var i = 0; i < all.length; i++) all[i].disabled = true
      Promise.resolve(onClick()).catch(function (e) { toast(String(e), true) }).then(function () { busy = false; refresh() })
    })
    return b
  }
  var REASONS = { gone: 'Already answered on the computer.', changed: 'The question changed. Look again.', 'not-live': 'That console has stopped.' }

  function answer(consoleId, a) {
    return api('/api/answer', { consoleId: consoleId, answer: a }).then(function (r) {
      if (r.ok) toast('Sent.')
      else toast(REASONS[r.reason] || 'Not sent.', true)
    })
  }
  function showTail(c) {
    api('/api/tail?id=' + encodeURIComponent(c.id)).then(function (r) {
      document.getElementById('sheet-title').textContent = c.name
      var body = document.getElementById('sheet-body')
      body.textContent = r.text || '(nothing yet)'
      document.getElementById('sheet').className = 'sheet'
      body.scrollTop = body.scrollHeight
    })
  }
  document.getElementById('sheet-close').addEventListener('click', function () {
    document.getElementById('sheet').className = 'sheet hidden'
  })

  function render(s) {
    document.getElementById('project').textContent = s.project ? s.project.name : 'Fleetboard'
    var n = s.approvals.length + s.asks.length + (s.ready ? 1 : 0)
    document.getElementById('count').textContent = n ? String(n) : ''
    document.title = (n ? '(' + n + ') ' : '') + 'Fleetboard Inbox'
    main.textContent = ''
    if (s.approvals.length || s.asks.length || s.ready) main.appendChild(el('h2', '', 'Needs you'))
    s.ready && (function (r) {
      var card = el('div', 'card')
      var who = el('div', 'who'); who.appendChild(el('b', '', r.lead)); who.appendChild(document.createTextNode(' finished'))
      card.appendChild(who)
      if (r.goal) card.appendChild(el('div', 'title', r.goal))
      card.appendChild(el('pre', '', r.summary))
      var verdicts = { passed: 'passed on this commit', failed: 'failed on this commit', stale: 'does not verify this commit', unobserved: 'no observed verification' }
      card.appendChild(el('div', 'muted', 'Fleetboard check: ' + (verdicts[r.verification] || verdicts.unobserved)))
      if (r.verified) card.appendChild(el('div', 'muted', 'Agent-reported: ' + r.verified))
      if (r.evidence) {
        var evidence = el('details', '')
        evidence.appendChild(el('summary', '', r.evidence.command + ' · exit ' + r.evidence.run.code))
        evidence.appendChild(el('pre', '', (r.evidence.run.head || '') + '\\n' + (r.evidence.run.tail || r.evidence.run.error || 'No output captured.')))
        card.appendChild(evidence)
      }
      if (r.branch) card.appendChild(el('div', 'muted', r.branch + ' · ' + r.commits + ' commits · ' + r.files + ' files'))
      var acts = el('div', 'actions')
      // where the board offers only Done (nothing to merge, or the work went to a PR) the phone offers no
      // Merge either: it has no Done, and main refuses to merge work that has a PR open
      if (r.closeOnly) {
        acts.appendChild(el('span', 'muted', r.prUrl ? 'A pull request is open for this work.' : 'Nothing to merge. Close it from the computer.'))
        if ((r.prUrl || '').indexOf('https://') === 0) {
          var pr = el('a', 'btn', 'Open the PR')
          pr.href = r.prUrl
          pr.target = '_blank'
          pr.rel = 'noopener noreferrer'
          acts.appendChild(pr)
        }
      } else acts.appendChild(button('Merge into my checkout', 'primary', function () {
        if (!confirm('Merge ' + (r.branch || 'the work') + ' into your checkout on the computer?')) return
        return api('/api/merge', { projectId: s.project.id, confirm: true, head: r.head || '' }).then(function (x) { x.ok ? toast('Merged' + (x.into ? ' into ' + x.into : '') + '.') : toast('Merge failed: ' + (x.error || ''), true) })
      }))
      card.appendChild(acts)
      main.appendChild(card)
    })(s.ready)
    s.asks.forEach(function (a) {
      var card = el('div', 'card')
      var who = el('div', 'who'); who.appendChild(el('b', '', a.from)); who.appendChild(document.createTextNode(' asks'))
      card.appendChild(who)
      card.appendChild(el('div', 'title', a.question))
      var acts = el('div', 'actions')
      a.options.forEach(function (o, i) {
        acts.appendChild(button(o, i === 0 ? 'primary' : '', function () {
          return api('/api/ask', { askId: a.id, answer: o }).then(function (r) { r.ok ? toast('Answered.') : toast('Already answered.', true) })
        }))
      })
      card.appendChild(acts)
      main.appendChild(card)
    })
    s.approvals.forEach(function (a) {
      var card = el('div', 'card')
      var who = el('div', 'who'); who.appendChild(el('b', '', a.name)); who.appendChild(document.createTextNode(' asks'))
      card.appendChild(who)
      card.appendChild(el('div', 'title', a.title))
      if (a.detail) card.appendChild(el('pre', '', a.detail))
      var acts = el('div', 'actions')
      a.options.forEach(function (o) {
        acts.appendChild(button(o.label, o.tone === 'allow' ? 'primary' : o.tone === 'deny' ? 'ghost' : '', function () { return answer(a.consoleId, o.answer) }))
      })
      if (!a.options.length) acts.appendChild(el('span', 'muted', 'Answer this one at the computer.'))
      acts.appendChild(button('Screen', 'ghost', function () { showTail({ id: a.consoleId, name: a.name }) }))
      card.appendChild(acts)
      main.appendChild(card)
    })
    main.appendChild(el('h2', '', 'Consoles'))
    if (!s.consoles.length) main.appendChild(el('div', 'empty', 'No consoles running.'))
    s.consoles.forEach(function (c) {
      var row = el('div', 'row')
      row.appendChild(el('span', 'name', c.name))
      row.appendChild(el('span', 'st ' + c.status, c.status === 'needs-you' ? 'needs you' : c.status))
      row.appendChild(button('Screen', 'ghost', function () { showTail(c) }))
      main.appendChild(row)
    })
  }

  function refresh() {
    if (!token) {
      main.textContent = ''
      main.appendChild(el('p', 'empty', 'Open the link from Fleetboard (Settings → Phone Inbox) on this phone.'))
      return
    }
    api('/api/state').then(function (s) {
      // a link that no longer works stops asking: every try counts against this address
      if (s.httpStatus === 401) { dead = true; clearTimeout(timer); main.textContent = ''; main.appendChild(el('p', 'empty', 'This link is no longer valid. Get a new one in Fleetboard (Settings → Phone Inbox).')); return }
      if (s.httpStatus === 429) { main.textContent = ''; main.appendChild(el('p', 'empty', 'Too many attempts from this address. Wait a minute.')); return }
      if (s.httpStatus !== 200) return
      if (!busy) render(s)
    }).catch(function () {
      document.getElementById('count').textContent = ''
      main.textContent = ''
      main.appendChild(el('p', 'empty', 'Can’t reach Fleetboard. Is the computer awake and on the same network?'))
    })
  }
  function loop() {
    clearTimeout(timer)
    if (dead) return
    if (!document.hidden) refresh()
    timer = setTimeout(loop, 2500)
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loop() })
  loop()
})()
`
