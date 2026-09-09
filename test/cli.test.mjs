import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnCapture } from '../plugins/openshunt/lib/worker.mjs';
const cli=path.resolve('plugins/openshunt/scripts/openshunt.mjs');
async function fixture(t) {
 const cwd=await mkdtemp(path.join(tmpdir(),'openshunt-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const executable=path.join(cwd,'worker');
 await writeFile(executable,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:'ANSWER',usage:{input_tokens:2}})));`,{mode:0o755});
 const env={...process.env,XDG_CONFIG_HOME:path.join(cwd,'config'),XDG_STATE_HOME:path.join(cwd,'state'),OPENSHUNT_WORKER_ACTIVE:''};
 const run=args=>spawnCapture(process.execPath,[cli,...args],{cwd,env,timeoutMs:5000});
 return {cwd,executable,env,run};
}
test('public CLI setup, multi-path reads, target receipt and stats',async t=>{
 const {cwd,executable,run}=await fixture(t);
 const setup=await run(['setup','--worker','claude','--model','small','--executable',executable]);assert.equal(setup.code,0,setup.stderr);
 await writeFile(path.join(cwd,'a b'),'source a');await writeFile(path.join(cwd,'c'),'source c');
 const read=await run(['bulk-read','--question','q','--paths','a b','c']);assert.equal(read.code,0,read.stderr);assert.equal(read.stdout,'ANSWER\n');
 const write=await run(['code-write','--spec','s','--reference','c','--target','out']);assert.equal(write.code,0,write.stderr);assert.match(write.stdout,/Wrote out/);assert.ok(!write.stdout.includes('ANSWER'));
 assert.equal(await readFile(path.join(cwd,'out'),'utf8'),'ANSWER\n');
 const conflict=await run(['code-write','--spec','s','--reference','c','--target','out']);assert.equal(conflict.code,1);assert.match(conflict.stderr,/exists/);
 assert.equal(JSON.parse((await run(['stats'])).stdout).calls,2);
});
test('CLI refuses missing required arguments and never picks a model',async t=>{
 const {run}=await fixture(t);
 for(const args of [['setup'],['bulk-read','--question','q'],['code-write','--spec','s'],['unknown']]) assert.equal((await run(args)).code,1);
 const doctor=await run(['doctor']);assert.equal(doctor.code,1);assert.match(doctor.stdout,/unset/);
});
test('project cannot configure an arbitrary executable',async t=>{
 const {cwd,run}=await fixture(t);await writeFile(path.join(cwd,'.openshunt.json'),JSON.stringify({worker:'claude',model:'x',executable:'/untrusted/binary'}));
 const result=await run(['doctor']);assert.equal(result.code,1);assert.match(result.stdout,/Executable paths/);
});
test('doctor checks required flags and does not expose auth account information',async t=>{
 const {cwd,executable,run}=await fixture(t);
 await writeFile(executable,`#!${process.execPath}\nif(process.argv.includes('--help'))console.log('--safe-mode --no-session-persistence --tools --strict-mcp-config --output-format');else console.log(JSON.stringify({loggedIn:true,email:'PRIVATE@example.test'}));`,{mode:0o755});
 await run(['setup','--worker','claude','--model','small','--executable',executable]);
 const result=await run(['doctor']);assert.equal(result.code,0,result.stderr);assert.ok(!result.stdout.includes('PRIVATE'));
});
