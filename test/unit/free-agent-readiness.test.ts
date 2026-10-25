import { test } from 'node:test'
import assert from 'node:assert/strict'
import { antigravityInputReady, freebuffInputReady, detectPrompt, answerKeys } from '../../src/main/status'
import type { ScreenView } from '../../src/main/screen'
const view=(lines:string[]):ScreenView=>({lines,cursorX:0,cursorY:lines.length-2,alt:true,cursorHidden:true,cols:100})
const rule='─'.repeat(100)
test('Antigravity waits for its empty framed composer, not onboarding or a user draft',()=>{
 assert.equal(antigravityInputReady(view(['Welcome to Antigravity CLI!','Choose your color scheme:','> terminal','  light'])),false)
 assert.equal(antigravityInputReady(view(['Do you trust the contents of this project?','> Yes, I trust this folder','  No, exit'])),false)
 assert.equal(antigravityInputReady(view([rule,'> user draft',rule,'? for shortcuts'])),false)
 assert.equal(antigravityInputReady(view([rule,'> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',rule,'? for shortcuts'])),true)
 assert.equal(antigravityInputReady(view([rule,'>',rule,'? for shortcuts'])),true)
 assert.equal(antigravityInputReady(view([rule,'>',rule,'? for shortcuts',...Array(20).fill('')])),true)
})
test('Freebuff session takeover blocks queued input and cannot be answered automatically',()=>{
 const prompt=detectPrompt(view(['Limited access without a subscription allows one session across CLI and Desktop. Take over to','stop the other session and use it here.','Enter: take over  Esc: back to draft']))
 assert.equal(prompt?.reason,'freebuff-session-limit')
 assert.equal(prompt?.kind,'input')
 assert.deepEqual(answerKeys(prompt,{enter:true}),{ok:false,reason:'changed'})
 assert.deepEqual(answerKeys(prompt,{yes:true}),{ok:false,reason:'changed'})
 assert.equal(detectPrompt(view([rule,'>',rule,'? for shortcuts'])),null)
})

test('Freebuff empty composer is ready despite timer redraws, while a busy composer or takeover is not',()=>{
 assert.equal(freebuffInputReady(view(['Session active','44m left','Enter a coding task or / for commands'])),true)
 assert.equal(freebuffInputReady(view(['working...','Add to the current task (/ for commands)'])),false)
 assert.equal(freebuffInputReady(view(['Enter a coding task or / for commands','Enter: take over Esc: back to draft'])),false)
 assert.equal(freebuffInputReady(view(['a user draft'])),false)
})

test('Freebuff role instructions use its exact native MCP names and preserve user task filenames',async()=>{
 const {fleetPromptFor}=await import('../../src/shared/agents')
 assert.equal(fleetPromptFor('freebuff','Call fleet_report and fleet_send.'),'Call fleet__fleet_report and fleet__fleet_send.')
 assert.equal(fleetPromptFor('freebuff','fleet__fleet_report'),'fleet__fleet_report')
 assert.equal(fleetPromptFor('antigravity','Call fleet_report.'),'Call fleet_report.')
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path')
 process.env.FLEETBOARD_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'fb-native-names-'))
 const {briefFor}=await import('../../src/main/fleet')
 const brief=briefFor({agentId:'freebuff',role:'worker',task:'Fix fleet_report.ts',owns:['fleet_report.ts']} as any)
 assert.ok(brief.includes('Task from the lead: Fix fleet_report.ts'))
 assert.ok(brief.includes('You own: fleet_report.ts'))
 assert.ok(brief.includes('call fleet__fleet_report'))
 assert.ok(!brief.includes('Fix fleet__fleet_report.ts'))
})
