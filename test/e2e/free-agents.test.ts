// Full app/team/MCP/worktree flow using scripted CLIs. This verifies Fleetboard's adapters;
// real provider authentication, model behavior and quota remain opt-in manual checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, FAKE_CLAUDE, makeRepo, makeSandbox } from './harness'

for (const agent of ['antigravity', 'freebuff'] as const) test(agent + ': chosen lead, inherited worker and reviewer complete a team', {timeout:120_000}, async()=>{
 const sb=makeSandbox(),repo=makeRepo(sb)
 let source=fs.readFileSync(FAKE_CLAUDE,'utf8').replace(/\r\n/g,'\n')
 if (agent==='antigravity') source=source.replace('`❯ ${input}`','`> ${input}`')
 if (agent==='freebuff') source=source.replace('`❯ ${input}`','`${input || (state === "working" ? "Add to the current task (/ for commands)" : "Enter a coding task or / for commands")}`')
 const config=agent==='antigravity'?['.gemini','config','mcp_config.json']:['.agents','mcp.json']
 source=source.replace('const mcpServer = (() => {', 'opts.mcpConfig = path.join(os.homedir(), ...'+JSON.stringify(config)+'); opts.allowed.push("mcp__fleet");\nconst mcpServer = (() => {')
 source=source.replace('const mcpUrl = mcpServer?.url', 'const mcpUrl = mcpServer?.url ?? mcpServer?.serverUrl') // Antigravity calls it serverUrl
 source=source.replace('async function turn(prompt) {', 'async function turn(prompt) {\n if(me.role==="solo"){const role=/You are (.+?), (the Lead|a worker|a reviewer)/.exec(prompt);if(role){me.name=role[1];me.role=role[2]==="the Lead"?"lead":role[2]==="a worker"?"worker":"reviewer";if(me.role==="worker")opts.mode="acceptEdits"}}')
 const script=path.join(sb.bin,'agent.mjs');fs.writeFileSync(script,source)
 const bin=agent==='antigravity'?'agy':'freebuff'
 if(process.platform==='win32')fs.writeFileSync(path.join(sb.bin,bin+'.cmd'),'@echo off\r\n"node" "%~dp0\\agent.mjs" %*\r\n')
 else fs.writeFileSync(path.join(sb.bin,bin),'#!/bin/sh\nexec "'+process.execPath+'" "'+script+'" "$@"\n',{mode:0o755})
 const originalProfile=process.env.USERPROFILE
 process.env.USERPROFILE=sb.home
 let app:App
 try{app=await App.launch({sandbox:sb,scenario:{lead:{tasks:[{task:'Write a.txt',owns:['a.txt'],done_when:'a.txt exists',name:'Ada'}],review:true}}})}
 finally{if(originalProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=originalProfile}
 try{
   const projectId=await app.openProject(repo)
   await app.eval((agent)=>(window as any).__fleetboard.useApp.getState().setSettings({teamAgent:agent}),agent)
   const lead=await app.invoke('fleet:startLead',{projectId,projectPath:repo,goal:'Write a.txt'})
   assert.equal(lead.agentId,agent)
   const ready=await app.waitFor(async()=>(await app.invoke('fleet:state',projectId)).ready,{timeout:90_000,label:agent+' Ready card'})
   assert.deepEqual(ready.files,['a.txt'])
   const members=Object.values((await app.invoke('fleet:state',projectId)).members) as any[]
   assert.deepEqual(members.map(m=>m.role).sort(),['lead','reviewer','worker'])
   assert.ok(members.every(m=>m.agentId===agent),'no hidden Claude fallback')
   assert.ok(members.find(m=>m.role==='reviewer')?.report?.includes('Looks good'))
   assert.equal((await app.invoke('fleet:mergeReady',projectId)).ok,true)
   assert.equal(fs.readFileSync(path.join(repo,'a.txt'),'utf8').replace(/\r\n/g,'\n'),'Ada was here\n')
   assert.equal(fs.existsSync(path.join(sb.fbHome,'agent-profiles',agent,lead.id)),false,'per-member tokens cleaned up')
 }finally{await app.close()}
})
