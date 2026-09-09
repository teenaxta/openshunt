#!/usr/bin/env node
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { delegate } from '../plugins/openshunt/lib/delegate.mjs';
import { loadConfig } from '../plugins/openshunt/lib/config.mjs';
import { route } from '../plugins/openshunt/lib/routing.mjs';

const {values:o}=parseArgs({options:{worker:{type:'string'},model:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
if(o.help) {console.log('node evals/benchmark.mjs --worker codex|claude --model MODEL [--output report.json]\nMakes four live worker calls. Tests host hook payload contracts, not live parent sessions.');process.exit(0);}
const cwd=await mkdtemp(path.join(tmpdir(),'openshunt-bench-'));
const rows=[];
try {
  const methods=Array.from({length:600},(_,i)=>`export function routine${i}(x) { return x + ${i}; }`).join('\n');
  await writeFile(path.join(cwd,'service.mjs'), methods+'\nexport function databaseLookup(id) { return db.find(id); }\n');
  await writeFile(path.join(cwd,'reference.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"+Array.from({length:400},(_,i)=>`test('reference ${i}', () => assert.equal(${i} + 1, ${i+1}));`).join('\n')+'\n');
  await writeFile(path.join(cwd,'handler.mjs'),methods+'\nexport function handleRequest(id) { return databaseLookup(id); }\n');
  const scenarios=[
    {name:'single-file',mode:'bulk-reader',files:['service.mjs'],task:'Name only the function that calls db.find.',expected:['databaseLookup']},
    {name:'source-test-pair',mode:'bulk-reader',files:['service.mjs','reference.test.mjs'],task:'Name the database function and identify the test framework in the reference.',expected:['databaseLookup','node:test']},
    {name:'multi-file',mode:'bulk-reader',files:['service.mjs','handler.mjs'],task:'Name the request handler and the database function it calls.',expected:['handleRequest','databaseLookup']},
    {name:'generation',mode:'code-writer',files:['reference.test.mjs'],task:"Generate exactly one node:test test file, importing node:test and node:assert/strict, with two tests: 2 + 2 equals 4 and 3 * 3 equals 9. Follow the reference's style.",target:'generated.test.mjs'}
  ];
  for(const scenario of scenarios) {
    const flags=Object.fromEntries(Object.entries({worker:o.worker,model:o.model}).filter(([,v])=>v));
    const config=await loadConfig({mode:scenario.mode,flags});
    const hookContracts={};
    for(const host of ['claude','codex']) {
      const full=host==='claude'?{tool_name:'Read',tool_input:{file_path:scenario.files[0]}}:{tool_name:'Bash',tool_input:{command:`cat ${scenario.files[0]}`}};
      const targeted=host==='claude'?{tool_name:'Read',tool_input:{file_path:scenario.files[0],limit:10}}:{tool_name:'Bash',tool_input:{command:`head -n 10 ${scenario.files[0]}`}};
      hookContracts[host]={largeReadBlocked:!!await route({cwd,...full},config),targetedReadAllowed:!(await route({cwd,...targeted},config))};
    }
    const result=await delegate({...scenario,config,cwd,env:{...process.env,XDG_STATE_HOME:path.join(cwd,'state')}});
    let quality;
    if(scenario.expected) quality={passed:scenario.expected.every(s=>result.visible.includes(s)),method:'Required-symbol checks; not semantic equivalence or a human review'};
    else {const check=spawnSync(process.execPath,['--test',path.join(cwd,scenario.target)],{encoding:'utf8'});quality={passed:check.status===0,method:'Run generated node:test file'};}
    const corpusBytes=(await Promise.all(scenario.files.map(f=>readFile(path.join(cwd,f))))).reduce((n,b)=>n+b.length,0);
    rows.push({scenario:scenario.name,...result.record,corpusBytes,estimatedParentContextReductionPercent:100*(1-result.record.parentVisibleBytes/corpusBytes),quality,hookContracts});
    console.error(`${scenario.name}: quality=${quality.passed}, worker=${config.worker}, latency=${result.record.latencyMs}ms`);
  }
  const report={timestamp:new Date().toISOString(),note:'Synthetic fixtures. Byte-based context estimates exclude parent instructions/tool overhead and are not billed-token or cost savings. Worker usage is CLI-reported. Hook contracts use host-shaped events, not actual parent sessions.',rows};
  const json=JSON.stringify(report,null,2)+'\n';
  if(o.output) {await mkdir(path.dirname(path.resolve(o.output)),{recursive:true});await writeFile(o.output,json);} else console.log(json);
  if(rows.some(r=>!r.quality.passed)) process.exitCode=1;
} finally {await rm(cwd,{recursive:true,force:true});}
