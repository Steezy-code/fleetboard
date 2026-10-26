import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fb-agy-run-'))
const home=path.join(tmp,'home'),bin=path.join(tmp,'bin'),log=path.join(tmp,'run.json')
fs.mkdirSync(home);fs.mkdirSync(bin)
process.env.FLEETBOARD_HOME=path.join(tmp,'fb')
process.env.HOME=home;process.env.USERPROFILE=home;process.env.SHELL='/bin/false'
process.env.PATH=bin+path.delimiter+path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'')
process.env.FAKE_AGY_LOG=log
const fake=path.join(bin,'agy.mjs')
fs.writeFileSync(fake,
 'import fs from "node:fs";import path from "node:path";let input="";for await(const c of process.stdin)input+=c;const prompt=JSON.parse(input).message.content;const home=process.platform==="win32"?process.env.USERPROFILE:process.env.HOME;const settings=JSON.parse(fs.readFileSync(path.join(home,".gemini","antigravity-cli","settings.json"),"utf8"));fs.writeFileSync(process.env.FAKE_AGY_LOG,JSON.stringify({args:process.argv.slice(2),prompt,settings,home}));'+
 'if(prompt==="wait")await new Promise(r=>setTimeout(r,60000));if(prompt==="truncated"){console.log(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",text_delta:"partial"}}));process.exit(0)}'+
 'const result=prompt==="fail"?{status:"ERROR",error:"quota reached"}:{status:"SUCCESS",response:"{\\"ok\\":true}"};const data=JSON.stringify({event:"init",init:{secret:"never forward"}})+"\\n"+JSON.stringify({event:"result",result});process.stdout.write(data.slice(0,17));setTimeout(()=>process.stdout.write(data.slice(17)),10);')
if(process.platform==='win32')fs.writeFileSync(path.join(bin,'agy.cmd'),'@echo off\r\n"node" "%~dp0\\agy.mjs" %*\r\n')
else fs.writeFileSync(path.join(bin,'agy'),'#!/bin/sh\nexec "'+process.execPath+'" "'+fake+'" "$@"\n',{mode:0o755})
const chunks:string[]=[]
before(async()=>{
 const {register}=await import('../../src/main/cli')
 const {DEFAULT_SETTINGS}=await import('../../src/shared/types')
 register({ipc:ipcMain as any,settings:()=>({...DEFAULT_SETTINGS,plannerAgent:'antigravity'}),emit:(name:string,_id:string,text:string)=>{if(name==='cli:chunk')chunks.push(text)}} as any)
})
const run=(prompt:string)=>ipcMain.invoke('cli:run',{runId:'test',prompt,cwd:tmp})
test('large hostile prompts use stdin, result-only output is emitted, and the isolated profile is cleaned',async()=>{
 chunks.length=0
 const prompt='--dangerously-skip-permissions '+ 'x'.repeat(150_000)
 assert.deepEqual(await run(prompt),{code:0,text:'{"ok":true}'})
 const seen=JSON.parse(fs.readFileSync(log,'utf8'))
 assert.equal(seen.prompt,prompt);assert.ok(seen.args.every((a:string)=>a.length<1000))
 assert.ok(seen.args.includes('--input-format'));assert.ok(seen.settings.permissions.deny.includes('write_file(*)'))
 assert.ok(seen.settings.permissions.deny.includes('mcp(*)'));assert.equal(fs.existsSync(seen.home),false)
 assert.equal(chunks.join(''),'{"ok":true}')
})
test('an ERROR result fails even when the CLI exits zero',async()=>{
 assert.deepEqual(await run('fail'),{code:1,text:'quota reached'})
})
test('an interrupted stream never counts as a finished planner reply',async()=>{
 assert.deepEqual(await run('truncated'),{code:1,text:'partial'})
})

test('cancelling a planner run cleans its temporary profile and returns failure',async()=>{
 const result=run('wait')
 let seen:any
 try {
   for(let i=0;i<100;i++){
     try{seen=JSON.parse(fs.readFileSync(log,'utf8'))}catch{ /* process has not logged yet */ }
     if(seen?.prompt==='wait')break
     await new Promise(resolve=>setTimeout(resolve,20))
   }
   assert.equal(seen?.prompt,'wait')
 }finally{await ipcMain.invoke('cli:cancel','test')}
 assert.equal((await result).code,1)
 assert.equal(fs.existsSync(seen.home),false)
})