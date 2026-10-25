import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fb-profiles-'))
process.env.FLEETBOARD_HOME=path.join(tmp,'fb')
const { agentProfile,removeAgentProfile,READ_ONLY_DENY }=await import('../../src/main/agent-profile')
const home=path.join(tmp,'home'), env={HOME:home,USERPROFILE:home}
const settingsFile=path.join(home,'.gemini','antigravity-cli','settings.json')
fs.mkdirSync(path.dirname(settingsFile),{recursive:true})
fs.mkdirSync(path.join(home,'.gemini','config'),{recursive:true})
fs.mkdirSync(path.join(home,'.agents'),{recursive:true})
fs.writeFileSync(settingsFile,JSON.stringify({model:'test-model',hooks:{start:'do not run'},permissions:{allow:['command(*)','write_file(*)'],deny:['read_file(secret)']}}))
fs.writeFileSync(path.join(home,'.gemini','config','mcp_config.json'),JSON.stringify({mcpServers:{mine:{serverUrl:'https://example.invalid'}}}))
fs.writeFileSync(path.join(home,'.agents','mcp.json'),JSON.stringify({mcpServers:{mine:{type:'http',url:'https://example.invalid'}}}))
const json=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'))
test('planner permissions override permissive user rules without changing the real settings',()=>{
 const before=fs.readFileSync(settingsFile,'utf8')
 const e=agentProfile('antigravity','planner',env,{readOnly:true})
 const settings=json(path.join(e.HOME!,'.gemini','antigravity-cli','settings.json'))
 assert.equal(settings.model,'test-model');assert.equal(settings.hooks,undefined)
 assert.deepEqual(settings.permissions.deny,['read_file(secret)',...READ_ONLY_DENY])
 assert.deepEqual(json(path.join(e.HOME!,'.gemini','config','mcp_config.json')).mcpServers,{})
 assert.equal(fs.readFileSync(settingsFile,'utf8'),before)
 removeAgentProfile('antigravity','planner')
 assert.equal(fs.existsSync(e.HOME!),false);assert.equal(fs.readFileSync(settingsFile,'utf8'),before)
})
test('members sharing a worktree get separate MCP identities and preserve user servers',()=>{
 for(const agent of ['antigravity','freebuff'] as const){
   const a=agentProfile(agent,'lead',env,{server:{url:'http://127.0.0.1:1/mcp/lead',token:'lead-only'}})
   const b=agentProfile(agent,'worker',env,{server:{url:'http://127.0.0.1:1/mcp/worker',token:'worker-only'}})
   const file=(h:string)=>agent==='antigravity'?path.join(h,'.gemini','config','mcp_config.json'):path.join(h,'.agents','mcp.json')
   assert.notEqual(a.HOME,b.HOME)
   assert.equal(json(file(a.HOME!)).mcpServers.fleet.headers.Authorization,'Bearer lead-only')
   assert.equal(json(file(b.HOME!)).mcpServers.fleet.headers.Authorization,'Bearer worker-only')
   assert.ok(json(file(a.HOME!)).mcpServers.mine)
   if(agent==='freebuff')assert.equal(a.FREEBUFF_CONFIG_DIR,path.join(home,'.config','manicode'))
   removeAgentProfile(agent,'lead');removeAgentProfile(agent,'worker')
   assert.ok(fs.existsSync(path.join(home,'.agents','mcp.json')))
 }
})
test('profile names cannot escape Fleetboard state',()=>{
 assert.throws(()=>agentProfile('freebuff','../escape',env),/Bad agent profile/)
 assert.throws(()=>removeAgentProfile('../escape','lead'),/Bad agent profile/)
})


test('Antigravity seeds completed native onboarding without letting planner resets overwrite it',()=>{
 const rel=path.join('.gemini','antigravity-cli','cache','onboarding.json')
 const realFile=path.join(home,rel)
 const completed={consumerOnboardingComplete:true,enterpriseOnboardingComplete:false,onboardingComplete:true}
 fs.mkdirSync(path.dirname(realFile),{recursive:true})
 fs.writeFileSync(realFile,JSON.stringify(completed))
 const first=agentProfile('antigravity','setup-planner',env,{readOnly:true})
 assert.deepEqual(json(path.join(first.HOME!,rel)),completed)
 assert.notEqual(fs.realpathSync(path.dirname(path.join(first.HOME!,rel))),fs.realpathSync(path.dirname(realFile)))
 // Observed native print-mode shutdown rewrites its local record as incomplete.
 fs.writeFileSync(path.join(first.HOME!,rel),JSON.stringify({onboardingComplete:false}))
 assert.deepEqual(json(realFile),completed)
 const concurrent=agentProfile('antigravity','setup-team',env)
 assert.deepEqual(json(path.join(concurrent.HOME!,rel)),completed)
 removeAgentProfile('antigravity','setup-planner');removeAgentProfile('antigravity','setup-team')
 assert.deepEqual(json(realFile),completed)
})

test('Antigravity never manufactures setup completion when the native record is missing',()=>{
 const rel=path.join('.gemini','antigravity-cli','cache','onboarding.json')
 fs.rmSync(path.join(home,rel),{force:true})
 const profile=agentProfile('antigravity','setup-missing',env)
 assert.equal(fs.existsSync(path.join(profile.HOME!,rel)),false)
 removeAgentProfile('antigravity','setup-missing')
 assert.equal(fs.existsSync(path.join(home,rel)),false)
})
