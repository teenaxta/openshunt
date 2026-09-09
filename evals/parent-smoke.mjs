#!/usr/bin/env node
// Real Claude parent -> either real worker. Codex parents use the trust-preserving manual flow.
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnCapture } from '../plugins/openshunt/lib/worker.mjs';
const { values:o }=parseArgs({options:{worker:{type:'string'},model:{type:'string'},'parent-model':{type:'string',default:'haiku'},output:{type:'string'}}});
if(!['claude','codex'].includes(o.worker)||!o.model) throw new Error('Required: --worker claude|codex --model MODEL');
const cwd=await mkdtemp(path.join(tmpdir(),'openshunt-parent-'));
const plugin=fileURLToPath(new URL('../plugins/openshunt',import.meta.url));
try {
 await writeFile(path.join(cwd,'.openshunt.json'),JSON.stringify({transport:'cli',worker:o.worker,model:o.model}));
 await writeFile(path.join(cwd,'large.txt'),'fixture line\n'.repeat(400)+'SPECIAL_MARKER=orchid\n');
 await writeFile(path.join(cwd,'reference.txt'),'GREETING=hello\n');
 const cli=`node ${JSON.stringify(path.join(plugin,'scripts/openshunt.mjs'))}`;
 const prompt=`Perform these exact steps in order for an integration test. Do not skip the first step because it is expected to fail.
1. Call Read for ${path.join(cwd,'large.txt')} with no offset or limit. The plugin should deny this. Do not retry a full read.
2. Call Read on the same file with offset 1 and limit 3. It should succeed.
3. Call Bash with: ${cli} bulk-read --question 'What is the SPECIAL_MARKER value? Answer concisely.' --paths large.txt
4. Call Bash with: ${cli} code-write --spec 'Write exactly GREETING=hello and a newline, matching the reference.' --reference reference.txt --target generated.txt
Do not read generated.txt. Finally state whether each operation succeeded or was denied as expected. Do not run any other commands.`;
 const env={...process.env,XDG_STATE_HOME:path.join(cwd,'state')}; delete env.CLAUDECODE; delete env.OPENSHUNT_WORKER_ACTIVE;
 const result=await spawnCapture('claude',['--print','--model',o['parent-model'],'--output-format','stream-json','--verbose','--include-hook-events',
   '--plugin-dir',plugin,'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
   '--tools','Read,Bash','--allowedTools','Read','Bash','--permission-mode','dontAsk','--no-session-persistence'],{cwd,env,input:prompt,timeoutMs:180000,maxOutputBytes:2*1048576});
 const events=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const tools=events.flatMap(e=>e.message?.content||[]).filter(c=>c.type==='tool_use').map(c=>({name:c.name,input:c.input}));
 const toolResults=events.flatMap(e=>e.message?.content||[]).filter(c=>c.type==='tool_result');
 const summarize=c=>typeof c.content==='string'?c.content:JSON.stringify(c.content);
 const denied=toolResults.some(c=>c.is_error && /OpenShunt.*(?:exceeds|bulk-reader)/s.test(summarize(c)));
 const targeted=tools.some(c=>c.name==='Read'&&c.input.limit===3)&&toolResults.some(c=>!c.is_error&&summarize(c).includes('fixture line'));
 const bulk=toolResults.some(c=>!c.is_error&&summarize(c).includes('orchid'));
 const write=toolResults.some(c=>!c.is_error&&summarize(c).includes('Wrote generated.txt'));
 const report={parent:'claude',parentModel:o['parent-model'],worker:o.worker,model:o.model,exitCode:result.code,checks:{largeReadDenied:denied,targetedReadPassed:targeted,bulkReadPassed:bulk,codeWritePassed:write},
   passed:result.code===0&&denied&&targeted&&bulk&&write,hookEvents:events.filter(e=>e.type?.startsWith('hook')).map(e=>({type:e.type,hook_event:e.hook_event,exit_code:e.exit_code})),final:events.findLast(e=>e.type==='result')?.result};
 if(o.output){await mkdir(path.dirname(path.resolve(o.output)),{recursive:true});await writeFile(o.output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
 if(!report.passed)process.exitCode=1;
} finally {await rm(cwd,{recursive:true,force:true});}
