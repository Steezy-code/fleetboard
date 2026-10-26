import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.FLEETBOARD_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'fb-free-input-'))
const {PtyManager}=await import('../../src/main/pty')
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
function fixture(){
 const manager=Object.create(PtyManager.prototype) as any
 const writes:string[]=[]
 let lines:string[]=[]
 const session={agentId:'freebuff',bracketed:true,tracker:{status:'idle',input(){}},screen:{async flush(){},view(){return {lines,cursorX:0,cursorY:0,alt:true,cursorHidden:true,cols:100}}},proc:{write(data:string){writes.push(data)}}}
 manager.sessions=new Map([['test',session]])
 return {manager,session,writes,question(){lines=['Do you trust the contents of this folder?','1. Yes, I trust this folder','2. No, exit']}}
}
test('Freebuff background delivery preserves a long Unicode brief as inline paste events before Enter',async()=>{
 const {manager,writes}=fixture()
 const text='x'.repeat(999)+'😀'.repeat(1100)+' end'
 await manager.paste('test',text,false)
 await manager.enter('test')
 const pastes=writes.filter(s=>s.startsWith('\x1b[200~')).map(s=>s.slice(6,-6))
 assert.equal(pastes.join(''),text)
 assert.ok(pastes.every(s=>s.length<=2000),'stays below native attachment threshold')
 assert.ok(pastes.every(s=>!s.includes('�')),'does not split Unicode characters')
 assert.equal(writes.at(-1),'\r')
 assert.equal(writes.at(-2),'\x1b[I','terminal focus before submission, without an OS window action')
})
test('Freebuff focus reports do not let an Enter answer a question that appeared during delivery',async()=>{
 const {manager,writes,question}=fixture()
 manager.write('test','\x1b[O')
 assert.deepEqual(writes,['\x1b[I'])
 const entering=manager.enter('test')
 await wait(20)
 question()
 await entering
 assert.ok(!writes.includes('\r'))
})
test('Freebuff delivery stops when the target console is replaced',async()=>{
 const {manager,session,writes}=fixture()
 const delivery=manager.paste('test','x'.repeat(3000),false)
 await wait(20)
 manager.sessions.set('test',{...session})
 await delivery
 assert.equal(writes.filter(s=>s.startsWith('\x1b[200~')).length,1)
 assert.ok(!writes.includes('\r'))
})
