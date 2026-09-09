#!/usr/bin/env node
// Opt-in real native agents. Test-only hook recorder; no persistent config changes.
import { mkdtemp, writeFile, readFile, mkdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnCapture } from '../plugins/openshunt/lib/worker.mjs';
import { installCodexAgents, DEFAULT_MODELS } from '../plugins/openshunt/lib/native.mjs';
const {values:o}=parseArgs({options:{host:{type:'string'},'reviewed-hook':{type:'boolean'},output:{type:'string'}}});
if(!['claude','codex'].includes(o.host)) throw Error('--host claude|codex required');
if(o.host==='codex'&&!o['reviewed-hook']) throw Error('Review the production hook first, then pass --reviewed-hook for test-only hook trust bypass.');
const cwd=await mkdtemp(path.join(tmpdir(),'openshunt-native-'));
const source=fileURLToPath(new URL('../plugins/openshunt',import.meta.url));
const plugin=path.join(cwd,'plugin');
try {
 await cp(source,plugin,{recursive:true});
 await mkdir(path.join(cwd,'config'));
 await writeFile(path.join(cwd,'.openshunt.json'),JSON.stringify({transport:'native',worker:o.host,model:DEFAULT_MODELS[o.host]}));
 await writeFile(path.join(cwd,'large.txt'),'fixture line\n'.repeat(400)+'SPECIAL_MARKER=orchid\n');
 await writeFile(path.join(cwd,'reference.txt'),'GREETING=hello\n');
 const log=path.join(cwd,'hooks.jsonl');
 const probe=fileURLToPath(new URL('./hook-probe.mjs',import.meta.url));
 const command=`node "${probe}" "${path.join(source,'hooks/pre-tool-use.mjs')}" "${log}"`;
 const matcher='Read|Bash|Agent|Task|spawn_agent|Write|Edit|apply_patch';
 await writeFile(path.join(plugin,'hooks/hooks.json'),JSON.stringify({hooks:{PreToolUse:[{matcher,hooks:[{type:'command',command,timeout:5}]}]}}));
 const cli=`node "${path.join(plugin,'scripts/openshunt.mjs')}"`;
 const prompt=`Perform an OpenShunt native integration test. Work in ${cwd}. First ${o.host==='claude'?'call Read on '+path.join(cwd,'large.txt')+' with no offset/limit':'run cat large.txt as a standalone shell command with workdir '+cwd}. Expect denial, do not retry a full read in the parent. Second ${o.host==='claude'?'call Read on that file with offset 1 and limit 3':'run head -n 3 large.txt'}; expect success. Third run ${cli} bulk-read --host ${o.host} --question 'What is the SPECIAL_MARKER value? Answer concisely.' --paths large.txt. It returns an envelope; actually invoke the named NATIVE ${o.host==='claude'?'Agent subagent_type with model haiku, run_in_background false':'spawn_agent agent_type with fork_context false (or fork_turns none if that is your schema)'}, supply only the envelope, and wait for its answer. Fourth run ${cli} code-write --host ${o.host} --spec 'Write exactly GREETING=hello and a newline matching the reference.' --reference reference.txt --target generated.txt, then invoke the named native agent with only that envelope, and wait for completion. Do not start codex exec or claude -p. Do not read generated.txt yourself. Finish with the answer and the publication receipt. Do not skip expected-denial step.`;
 const env={...process.env,XDG_CONFIG_HOME:path.join(cwd,'config'),XDG_STATE_HOME:path.join(cwd,'state')};
 delete env.CLAUDECODE;delete env.OPENSHUNT_WORKER_ACTIVE;
 for(const key of ['CODEX_APP_TOOLS_PIPE_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_PERMISSION_PROFILE','CODEX_SESSION_ID','CODEX_THREAD_ID']) delete env[key];
 let args;
 if(o.host==='codex'){
  const files=await installCodexAgents({cwd,scope:'project',configs:{'bulk-reader':{model:DEFAULT_MODELS.codex},'code-writer':{model:DEFAULT_MODELS.codex}},env});
  args=['exec','--model',DEFAULT_MODELS.codex,'--ignore-user-config','--skip-git-repo-check','--sandbox','workspace-write','-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=true','--disable','plugins','--enable','multi_agent','--enable','hooks','-c',`hooks.PreToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`,'--dangerously-bypass-hook-trust','--json'];
  for(const file of files){const name=path.basename(file,'.toml');args.push('-c',`agents.${name}.config_file=${JSON.stringify(file)}`,'-c',`agents.${name}.description="OpenShunt native worker"`);}
  args.push('-');
 } else args=['--print','--model','haiku','--output-format','stream-json','--verbose','--include-hook-events','--plugin-dir',plugin,'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Read,Bash,Agent,Write','--allowedTools','Read','Bash','Agent','Write','--permission-mode','dontAsk','--no-session-persistence'];
 const started=Date.now();
 const result=await spawnCapture(o.host,args,{cwd,env,input:prompt,timeoutMs:240000,maxOutputBytes:4*1048576});
 const evidence=(await readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
 const generated=await readFile(path.join(cwd,'generated.txt'),'utf8').catch(()=>null);
 const events=result.stdout.trim().split('\n').filter(Boolean).flatMap(s=>{try{return[JSON.parse(s)]}catch{return[]}});
 const final=o.host==='claude'?events.findLast(e=>e.type==='result')?.result:events.filter(e=>e.type==='item.completed').map(e=>e.item).findLast(i=>i.type==='agent_message')?.text;
 const checks={parentReadDenied:evidence.some(e=>e.decision==='deny'&&!e.agent_id&&(e.tool==='Read'||e.command==='cat large.txt')),targetedReadAllowed:evidence.some(e=>e.decision==='pass'&&!e.agent_id&&(e.limit===3||e.command?.includes('head -n 3'))),nativeWorkerRead:evidence.some(e=>e.agent_id&&e.agent_type?.includes('bulk')&&e.decision==='pass'),answer:final?.includes('orchid')===true,publication:generated==='GREETING=hello\n'};
 const report={host:o.host,model:DEFAULT_MODELS[o.host],parentSandbox:o.host==='codex'?'workspace-write':'dontAsk',latencyMs:Date.now()-started,checks,passed:result.code===0&&Object.values(checks).every(Boolean),evidence,final,usage:events.filter(e=>e.type==='turn.completed'||e.type==='result').map(e=>e.usage),trust:'Isolated test hook recorder; Codex uses a one-invocation reviewed-hook trust bypass. Marketplace installation and interactive hook trust are not tested.'};
 if(!report.passed){report.debug=events;report.stderr=result.stderr;}
 if(o.output){await mkdir(path.dirname(path.resolve(o.output)),{recursive:true});await writeFile(o.output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify({...report,debug:undefined},null,2));
 if(!report.passed)process.exitCode=1;
}finally{await rm(cwd,{recursive:true,force:true});}
