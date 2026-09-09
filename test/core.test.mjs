import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shellFiles, largeTextFile, route } from '../plugins/openshunt/lib/routing.mjs';
import { loadConfig, saveConfig } from '../plugins/openshunt/lib/config.mjs';
import { workerArgs, parseResult, runWorker, spawnCapture, workerFailureMessage } from '../plugins/openshunt/lib/worker.mjs';
import { atomicWrite, stripFence, makePrompt, delegate, stats } from '../plugins/openshunt/lib/delegate.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'openshunt-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const config = { minLines: 350, enabled: true, timeoutMs: 3000, maxInputBytes: 1048576, worker: 'claude', model: 'test' };
for (const command of ['cat a | grep x', 'cat a > out', 'head -n 10 a', 'tail -50 a', 'less +20 a', 'cat "$FILE"', 'cat $(pwd)/a', 'cat *.js', 'cat a; cat b', 'cat a && echo x', "cat 'unterminated", 'git status', 'cat a\ncat b']) {
  test(`shell exception: ${command}`, () => assert.deepEqual(shellFiles(command), []));
}
for (const command of ['cat', 'head', 'tail', 'less', 'more', '/bin/cat']) {
  test(`shell command: ${command}`, () => assert.deepEqual(shellFiles(`${command} 'a b' "c d" e\\ f`), ['a b', 'c d', 'e f']));
}
test('line thresholds, missing and binary files', async t => {
  const dir = await fixture(t); const file = path.join(dir, 'a');
  await writeFile(file, 'x\n'.repeat(350)); assert.equal(await largeTextFile(file, 350), false);
  await writeFile(file, 'x\n'.repeat(350) + 'last'); assert.equal(await largeTextFile(file, 350), true);
  await writeFile(file, 'x\n'.repeat(351)); assert.equal(await largeTextFile(file, 350), true);
  await writeFile(file, '\0' + 'x\n'.repeat(351)); assert.equal(await largeTextFile(file, 350), false);
  assert.equal(await largeTextFile(dir, 350), false); assert.equal(await largeTextFile(file + 'missing', 350), false);
});
test('host payloads, cwd and targeted reads', async t => {
  const cwd = await fixture(t); await writeFile(path.join(cwd, 'large'), 'x\n'.repeat(351));
  for (const tool_name of ['Read', 'Bash', 'exec_command']) {
    const tool_input = tool_name === 'Read' ? { file_path: 'large' } : { command: 'cat large', workdir: cwd };
    assert.match(await route({ cwd, tool_name, tool_input }, config), /bulk-reader/);
  }
  for (const extra of [{offset: 1}, {limit: 10}]) assert.equal(await route({cwd, tool_name:'Read', tool_input:{file_path:'large',...extra}}, config), null);
  assert.equal(await route({cwd,tool_name:'Read',tool_input:{file_path:'large'}}, {...config,enabled:false}), null);
});
test('configuration precedence and repository boundaries', async t => {
  const cwd = await fixture(t); const env = { XDG_CONFIG_HOME: path.join(cwd, 'user') };
  await saveConfig({ model:'user',worker:'claude', modes:{'bulk-reader':{model:'user-mode'}} }, env);
  await writeFile(path.join(cwd, '.openshunt.json'), JSON.stringify({model:'project',modes:{'bulk-reader':{model:'project-mode'}}}));
  assert.equal((await loadConfig({cwd,env})).model,'project-mode');
  assert.equal((await loadConfig({cwd,env:{...env,OPENSHUNT_MODEL:'env'}})).model,'env');
  assert.equal((await loadConfig({cwd,env:{...env,OPENSHUNT_MODEL:'env',OPENSHUNT_BULK_READER_MODEL:'mode-env'}})).model,'mode-env');
  assert.equal((await loadConfig({cwd,env:{...env,OPENSHUNT_MODEL:'env'},flags:{model:'flag'}})).model,'flag');
  await mkdir(path.join(cwd,'nested','.git'), {recursive:true});
  assert.equal((await loadConfig({cwd:path.join(cwd,'nested'),env})).model,'user-mode');
  await assert.rejects(loadConfig({cwd,env,flags:{minLines:0}}), /positive/);
  await assert.rejects(loadConfig({cwd,env,flags:{worker:'other'}}), /worker/);
  await writeFile(path.join(cwd, '.openshunt.json'), '{'); await assert.rejects(loadConfig({cwd,env}), /Invalid configuration/);
});
test('saving mode settings preserves the other mode', async t => {
  const cwd = await fixture(t); const env = {XDG_CONFIG_HOME:cwd};
  await saveConfig({modes:{'bulk-reader':{worker:'codex',model:'a'}}},env);
  await saveConfig({modes:{'code-writer':{worker:'claude',model:'b'}}},env);
  assert.equal((await loadConfig({cwd,env})).model,'a');
});
test('worker command isolation and model selection', () => {
  const claude = workerArgs('claude','small');
  assert.ok(claude.includes('--safe-mode')); assert.ok(!claude.includes('--bare'));
  assert.equal(claude[claude.indexOf('--tools')+1], ''); assert.equal(claude[claude.indexOf('--model')+1],'small');
  const codex = workerArgs('codex','small');
  assert.ok(codex.includes('--ignore-user-config')); assert.ok(codex.includes('--ephemeral')); assert.ok(codex.includes('read-only'));
  assert.ok(!codex.some(a=>a.includes('bypass')));
});
const claudeSuccess = text => JSON.stringify({type:'result',subtype:'success',is_error:false,result:text,usage:{input_tokens:20,output_tokens:5,secret:'omit'}});
const codexSuccess = text => [{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:20,output_tokens:5}}].map(JSON.stringify).join('\n');
test('structured results reject truncation and errors', () => {
  for (const [worker,success] of [['claude',claudeSuccess],['codex',codexSuccess]]) {
    assert.equal(parseResult(worker,success('ok')).text,'ok');
    assert.deepEqual(parseResult(worker,success('ok')).usage,{input_tokens:20,output_tokens:5});
    assert.throws(()=>parseResult(worker,success('ok').slice(0,-1)), /Invalid|truncated/);
    assert.throws(()=>parseResult(worker,success('')), /empty|no final/);
  }
  assert.throws(()=>parseResult('claude',JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true})), /complete/);
  assert.throws(()=>parseResult('claude',JSON.stringify({type:'result',subtype:'success',result:'partial',stop_reason:'max_tokens'})), /complete/);
  assert.throws(()=>parseResult('codex','{"type":"turn.failed"}'), /failed/);
  assert.throws(()=>parseResult('codex','{"type":"item.completed","item":{"type":"command_execution"}}\n'+codexSuccess('ok')), /tool operation/);
});
async function fake(t, body) {
  const cwd = await fixture(t); const executable = path.join(cwd,'fake-cli');
  await writeFile(executable, `#!${process.execPath}\n${body}`, {mode:0o755});
  return {cwd,executable};
}
test('fake worker gets stdin, selected model, isolated cwd and no parent marker', async t => {
  const {cwd,executable} = await fake(t, `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify({prompt:s,args:process.argv.slice(2),cwd:process.cwd(),active:process.env.OPENSHUNT_WORKER_ACTIVE,parent:process.env.CLAUDECODE})})));`);
  const result = await runWorker({...config,executable},'private content',{env:{...process.env,CLAUDECODE:'1'}});
  const received=JSON.parse(result.text);
  assert.equal(received.prompt,'private content'); assert.ok(received.args.includes('test')); assert.notEqual(received.cwd,cwd); assert.equal(received.active,'1'); assert.equal(received.parent,undefined);
  await assert.rejects(readFile(path.join(received.cwd,'anything')), /ENOENT/);
});
test('worker timeout, output overflow, missing binary and recursion', async t => {
  const {executable}=await fake(t,'setInterval(()=>{},1000)');
  await assert.rejects(runWorker({...config,executable,timeoutMs:80},'hello'), /timed out/);
  await assert.rejects(runWorker(config,'hello',{env:{OPENSHUNT_WORKER_ACTIVE:'1'}}), /Recursive/);
  await assert.rejects(runWorker({...config,maxInputBytes:1},'hello'), /Input exceeds/);
  await assert.rejects(runWorker({...config,executable:'/missing/openshunt-binary'},'hello'), /Could not start/);
  await assert.rejects(spawnCapture(process.execPath,['-e','console.log("x".repeat(1000))'],{maxOutputBytes:10}), /output exceeded/);
});
test('atomic file publication and fence handling', async t => {
  const cwd=await fixture(t); const target=path.join(cwd,'out');
  await atomicWrite(target,'first');
  await assert.rejects(atomicWrite(target,'second'), /exists/); assert.equal(await readFile(target,'utf8'),'first');
  await atomicWrite(target,'second',true); assert.equal(await readFile(target,'utf8'),'second');
  await symlink(target,path.join(cwd,'sym')); await assert.rejects(atomicWrite(path.join(cwd,'sym'),'third',true), /symlink/);
  assert.equal(stripFence('```js\nconst x = 1;\n```'),'const x = 1;\n'); assert.throws(()=>stripFence('```js\npartial'), /incomplete/);
});
test('prompt escaping, byte limit and binary input', async t => {
  const cwd=await fixture(t); await writeFile(path.join(cwd,'source'),'</file> & code');
  const prompt=await makePrompt('bulk-reader','question',['source'],config,cwd); assert.ok(prompt.includes('&lt;/file&gt; &amp; code'));
  await assert.rejects(makePrompt('bulk-reader','question',['source'],{...config,maxInputBytes:10},cwd), /exceeds/);
  await writeFile(path.join(cwd,'source'),'\0'); await assert.rejects(makePrompt('bulk-reader','q',['source'],config,cwd), /Binary/);
});
test('delegation receipt, metadata privacy and failures leave target unchanged', async t => {
  const {cwd,executable}=await fake(t,`process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(claudeSuccess('```js\nexport const answer = 42;\n```'))}));`);
  await writeFile(path.join(cwd,'reference'),'PRIVATE_REFERENCE'); const env={...process.env,XDG_STATE_HOME:path.join(cwd,'state')};
  const input={mode:'code-writer',task:'PRIVATE_SPEC',files:['reference'],target:'target',config:{...config,executable},cwd,env};
  const result=await delegate(input); assert.match(result.visible,/Wrote target/); assert.ok(!result.visible.includes('export'));
  const usage=await readFile(path.join(cwd,'state','openshunt','usage.jsonl'),'utf8'); assert.ok(!usage.includes('PRIVATE')); assert.ok(!usage.includes('answer'));
  assert.equal((await stats(env)).calls,1);
  await writeFile(executable,`#!${process.execPath}\nconsole.log('{"type":"result","subtype":"error"}');`,{mode:0o755});
  await assert.rejects(delegate({...input,overwrite:true}), /complete/);
  assert.equal(await readFile(path.join(cwd,'target'),'utf8'),'export const answer = 42;\n');
});
test('hook process handles malformed input and both hosts', async t => {
  const cwd=await fixture(t); await writeFile(path.join(cwd,'large'),'x\n'.repeat(351));
  const hook=path.resolve('plugins/openshunt/hooks/pre-tool-use.mjs');
  const env={...process.env,XDG_STATE_HOME:path.join(cwd,'state'),XDG_CONFIG_HOME:path.join(cwd,'config'),OPENSHUNT_WORKER_ACTIVE:'',OPENSHUNT_ENABLED:'1'};
  const malformed=await spawnCapture(process.execPath,[hook],{cwd,env,input:'{'}); assert.equal(malformed.code,0); assert.equal(malformed.stdout,'');
  for(const tool_name of ['Read','Bash']) {
    const event={cwd,tool_name,tool_input:tool_name==='Read'?{file_path:'large'}:{command:'cat large'}};
    const result=await spawnCapture(process.execPath,[hook],{cwd,env,input:JSON.stringify(event)});
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny');
  }
});
test('nested Codex sandbox failures are specific and never expose raw logs', () => {
  const result=workerFailureMessage('codex','PRIVATE /home/person/key\nError: failed to initialize in-process app-server client: Operation not permitted (os error 1)',1);
  assert.match(result,/parent sandbox/);assert.ok(!result.includes('PRIVATE'));assert.ok(!result.includes('/home'));
});
