import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, nativeRequest, installCodexAgents, codexAgentStatus, publishNative, workerIdentity } from '../plugins/openshunt/lib/native.mjs';
import { handlePreTool } from '../plugins/openshunt/lib/hooks.mjs';
import { saveConfig } from '../plugins/openshunt/lib/config.mjs';
async function fixture(t){const cwd=await mkdtemp(path.join(os.tmpdir(),'openshunt-native-test-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(path.join(cwd,'.git'));return {cwd,env:{XDG_STATE_HOME:path.join(cwd,'state'),XDG_CONFIG_HOME:path.join(cwd,'config'),CODEX_HOME:path.join(cwd,'codex')}};}
test('native defaults, explicit CLI cross-host transport, host/mode precedence',async t=>{
 const f=await fixture(t);
 assert.equal((await resolveConfig({...f,host:'claude'})).model,'haiku');
 assert.equal((await resolveConfig({...f,host:'codex'})).transport,'native');
 assert.equal((await resolveConfig({...f,host:'claude',flags:{worker:'codex'}})).transport,'cli');
 await assert.rejects(resolveConfig({...f,host:'claude',flags:{worker:'codex',transport:'native'}}),/Cross-host/);
 await saveConfig({hosts:{claude:{model:'user',modes:{'bulk-reader':{model:'user-mode'}}}}},f.env);
 await writeFile(path.join(f.cwd,'.openshunt.json'),JSON.stringify({hosts:{claude:{model:'project'}}}));
 assert.equal((await resolveConfig({...f,host:'claude'})).model,'project');
 const env={...f.env,OPENSHUNT_CLAUDE_MODEL:'environment'};
 assert.equal((await resolveConfig({...f,env,host:'claude'})).model,'environment');
 assert.equal((await resolveConfig({...f,env,host:'claude',flags:{model:'flag'}})).model,'flag');
});
test('only identified workers get read exemption and cannot delegate recursively',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.cwd,'large'),'x\n'.repeat(351));
 const parent={cwd:f.cwd,tool_name:'Read',tool_input:{file_path:path.join(f.cwd,'large')}};
 assert.ok(await handlePreTool(parent,f.env));
 assert.ok(await handlePreTool({...parent,agent_type:'openshunt:bulk-reader'},f.env));
 assert.ok(await handlePreTool({...parent,agent_type:'unrelated',agent_id:'child'},f.env));
 const child={...parent,agent_type:'openshunt:bulk-reader',agent_id:'child'};
 assert.equal(await handlePreTool(child,f.env),null);
 assert.ok(await handlePreTool({...child,tool_name:'Agent'},f.env));
 assert.ok(await handlePreTool({...child,tool_name:'Write'},f.env));
 assert.equal(workerIdentity({...child,agent_id:''}),null);
 assert.equal(await handlePreTool(parent,{...f.env,OPENSHUNT_ENABLED:'0'}),null);
});
test('Claude spawn checks configured model without granting permission',async t=>{
 const f=await fixture(t);const e={cwd:f.cwd,tool_name:'Agent',tool_input:{subagent_type:'openshunt:bulk-reader',model:'sonnet'}};
 assert.ok(await handlePreTool(e,f.env));
 assert.equal(await handlePreTool({...e,tool_input:{...e.tool_input,model:'haiku'}},f.env),null);
});
test('Codex roles, model and fresh context checked; unrelated definitions preserved',async t=>{
 const f=await fixture(t);const configs={'bulk-reader':{model:'gpt-5.6-luna'}};
 const [file]=await installCodexAgents({...f,scope:'project',configs});
 assert.equal((await codexAgentStatus({...f,mode:'bulk-reader',model:'gpt-5.6-luna'})).ready,true);
 const e={cwd:f.cwd,model:'parent',tool_name:'spawn_agent',tool_input:{agent_type:'openshunt_bulk_reader'}};
 assert.ok(await handlePreTool(e,f.env));
 assert.equal(await handlePreTool({...e,tool_input:{...e.tool_input,fork_context:false}},f.env),null);
 const child={cwd:f.cwd,agent_id:'child',agent_type:'openshunt_bulk_reader',model:'wrong',tool_name:'Bash',tool_input:{command:'cat file'}};
 assert.ok(await handlePreTool(child,f.env));
 assert.equal(await handlePreTool({...child,model:'gpt-5.6-luna'},f.env),null);
 await writeFile(file,'model = "mine"\n');
 await assert.rejects(installCodexAgents({...f,scope:'project',configs}),/unrelated/);
 assert.equal(await readFile(file,'utf8'),'model = "mine"\n');
});
test('native envelope contains paths but no source; validates bounds and target',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.cwd,'input'),'SECRET_SOURCE');
 const args={...f,host:'claude',mode:'bulk-reader',task:'Summarize',files:['input']};
 const request=await nativeRequest(args);assert.equal(request.transport,'native');assert.ok(!JSON.stringify(request).includes('SECRET_SOURCE'));assert.equal(request.paths[0],path.join(f.cwd,'input'));
 await assert.rejects(nativeRequest({...args,flags:{maxInputBytes:2}}),/split/);
 await assert.rejects(nativeRequest({...args,mode:'code-writer'}),/target/);
});
test('native publication validates staging and preserves target on failure',async t=>{
 const f=await fixture(t);const target=path.join(f.cwd,'target'),staged=path.join(f.cwd,'stage');
 await writeFile(target,'original');await writeFile(staged,'```js\nincomplete');
 await assert.rejects(publishNative({target,staged,overwrite:true}),/incomplete/);assert.equal(await readFile(target,'utf8'),'original');
 await writeFile(staged,'```js\ncomplete();\n```');
 await assert.rejects(publishNative({target,staged}),/exists/);
 await assert.rejects(publishNative({target,staged,overwrite:true,maxInputBytes:NaN}),/positive/);
 await publishNative({target,staged,overwrite:true});assert.equal(await readFile(target,'utf8'),'complete();\n');
 await assert.rejects(readFile(staged),{code:'ENOENT'});
});
test('native one-off model overrides cannot disagree with independent hooks',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.cwd,'input'),'source');
 await assert.rejects(nativeRequest({...f,host:'claude',mode:'bulk-reader',task:'Summarize',files:['input'],flags:{model:'sonnet'}}),/saved with setup/);
});
test('project configuration save preserves user settings and other host modes',async t=>{
 const f=await fixture(t);await saveConfig({model:'user'},f.env);
 const file=path.join(f.cwd,'.openshunt.json');
 await saveConfig({hosts:{codex:{modes:{'bulk-reader':{model:'first'}}}}},f.env,file);
 await saveConfig({hosts:{codex:{modes:{'code-writer':{model:'second'}}}}},f.env,file);
 const value=JSON.parse(await readFile(file));assert.equal(value.hosts.codex.modes['bulk-reader'].model,'first');
 assert.equal(JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME,'openshunt/config.json'))).model,'user');
});
