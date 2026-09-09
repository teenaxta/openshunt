#!/usr/bin/env node
// Opt-in, isolated automation of the exact reviewed hook source. Never used by the plugin runtime.
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnCapture } from '../plugins/openshunt/lib/worker.mjs';
const {values:o}=parseArgs({options:{worker:{type:'string'},model:{type:'string'},'parent-model':{type:'string',default:'gpt-5.6-luna'},'reviewed-hook':{type:'boolean'},'parent-sandbox':{type:'string',default:'workspace-write'},output:{type:'string'}}});
if(!o['reviewed-hook'])throw new Error('Read hooks/pre-tool-use.mjs and its imports first, then explicitly pass --reviewed-hook. This test uses Codex’s one-invocation hook-trust bypass, never its sandbox/approval bypass.');
if(!['claude','codex'].includes(o.worker)||!o.model)throw new Error('Required: --worker claude|codex --model MODEL');
if(!['workspace-write','danger-full-access'].includes(o['parent-sandbox']))throw new Error('Unsupported parent sandbox');
const cwd=await mkdtemp(path.join(tmpdir(),'openshunt-codex-parent-'));
const plugin=fileURLToPath(new URL('../plugins/openshunt',import.meta.url));
try {
 await writeFile(path.join(cwd,'.openshunt.json'),JSON.stringify({transport:'cli',worker:o.worker,model:o.model}));
 await writeFile(path.join(cwd,'large.txt'),'fixture line\n'.repeat(400)+'SPECIAL_MARKER=orchid\n');
 await writeFile(path.join(cwd,'reference.txt'),'GREETING=hello\n');
 const cli=`node ${JSON.stringify(path.join(plugin,'scripts/openshunt.mjs'))}`;
 const prompt=`Perform these exact commands separately in order for an integration test. Set the working directory of EVERY command explicitly to ${cwd}. First run cat large.txt as a single command, expecting the OpenShunt hook to deny it. Do not use a pipeline or retry the full read.
Second run head -n 3 large.txt, expecting success.
Third run ${cli} bulk-read --question 'What is the SPECIAL_MARKER value? Answer concisely.' --paths large.txt
Fourth run ${cli} code-write --spec 'Write exactly GREETING=hello and a newline, matching the reference.' --reference reference.txt --target generated.txt
Do not read generated.txt, run other commands or spawn agents. Finally state whether all four steps behaved as expected.`;
 const hookLog=path.join(cwd,'hook-evidence.jsonl');
 const probe=fileURLToPath(new URL('./hook-probe.mjs',import.meta.url));
 const command=`node "${probe}" "${path.join(plugin,'hooks/pre-tool-use.mjs')}" "${hookLog}"`;
 const hook=`hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`;
 const env={...process.env,XDG_STATE_HOME:path.join(cwd,'state')};delete env.OPENSHUNT_WORKER_ACTIVE;
 const result=await spawnCapture('codex' ,['exec','--model',o['parent-model'],'--ephemeral','--ignore-user-config','--skip-git-repo-check',
  '--sandbox',o['parent-sandbox'],'-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=true',
  '--disable','plugins','--disable','multi_agent','--enable','hooks','-c',hook,'--dangerously-bypass-hook-trust','--json','-'],{cwd,env,input:prompt,timeoutMs:180000,maxOutputBytes:2*1048576});
 const events=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const items=events.filter(e=>e.type==='item.completed').map(e=>e.item);
 const hookEvidence=(await readFile(hookLog,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const commands=items.filter(i=>i.type==='command_execution');
 const checks={largeReadDenied:hookEvidence.some(e=>e.command==='cat large.txt'&&e.decision==='deny')&&!commands.some(i=>/['\"]cat large\.txt['\"]/.test(i.command||'')),targetedReadPassed:commands.some(i=>i.command?.includes('head -n 3')&&i.exit_code===0&&i.aggregated_output?.includes('fixture line')),
 bulkReadPassed:commands.some(i=>i.command?.includes(' bulk-read ')&&i.exit_code===0&&i.aggregated_output?.includes('orchid')),
 codeWritePassed:commands.some(i=>i.command?.includes(' code-write ')&&i.exit_code===0&&i.aggregated_output?.includes('Wrote generated.txt'))};
 const report={parent:'codex',parentSandbox:o['parent-sandbox'],parentModel:o['parent-model'],worker:o.worker,model:o.model,exitCode:result.code,checks,hookEvidence,passed:result.code===0&&Object.values(checks).every(Boolean),
 trust:'One-invocation bypass for explicitly reviewed test hook; normal plugin trust UI and marketplace discovery are not exercised.',
 final:items.findLast(i=>i.type==='agent_message')?.text};
 if(!report.passed)report.commandResults=commands.map(i=>({command:i.command,exitCode:i.exit_code,output:i.aggregated_output}));
 if(o.output){await mkdir(path.dirname(path.resolve(o.output)),{recursive:true});await writeFile(o.output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
} finally {await rm(cwd,{recursive:true,force:true});}
