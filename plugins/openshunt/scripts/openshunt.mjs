#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig, MODES } from '../lib/config.mjs';
import { savings, formatSavings } from '../lib/savings.mjs';
import { delegate, stats } from '../lib/delegate.mjs';
import { spawnCapture, runWorker } from '../lib/worker.mjs';
import { DEFAULT_MODELS, resolveConfig, nativeRequest, publishNative, installCodexAgents, codexAgentStatus } from '../lib/native.mjs';

const HELP = `OpenShunt — native subagents by default, CLI workers by explicit selection

  openshunt bulk-read --host claude|codex --question "..." --paths file1 file2
  openshunt code-write --host claude|codex --spec "..." --reference example --target output
  openshunt setup --host claude|codex [--model MODEL] [--mode bulk-reader|code-writer]
  openshunt setup --transport cli --worker claude|codex --model MODEL
  openshunt doctor [--host claude|codex] [--live]
  openshunt resolve --host claude|codex [--mode bulk-reader|code-writer]
  openshunt publish --staged FILE --target FILE [--overwrite]
  openshunt savings [--json]
  openshunt stats

Native bulk-read/code-write return a task envelope for the parent's Agent/spawn_agent tool.
They never launch a CLI worker. --transport cli explicitly invokes the retained CLI backend.
Native defaults: Claude=haiku, Codex=gpt-5.6-luna. --scope project installs Codex agents locally.
Overrides: --transport, --worker, --model, --executable, --timeout-ms, --max-input-bytes, --min-lines
`;
function options(argv) {
  // Support the reference's --paths a b as well as repeated --paths a --paths b.
  const normalized = []; let paths = false;
  for (const arg of argv) {
    if (arg === '--paths') { paths = true; continue; }
    if (arg.startsWith('--')) paths = false;
    if (paths) normalized.push('--paths', arg); else normalized.push(arg);
  }
  const strings = ['question', 'spec', 'reference', 'target', 'worker', 'model', 'executable', 'timeout-ms', 'max-input-bytes', 'min-lines', 'mode', 'host', 'transport', 'scope', 'staged'];
  return parseArgs({ args: normalized, strict: true, options: {
    ...Object.fromEntries(strings.map(k => [k, { type: 'string' }])), paths: { type: 'string', multiple: true },
    json: { type: 'boolean' }, overwrite: { type: 'boolean' }, live: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } }).values;
}
function overrides(o) {
  return Object.fromEntries(Object.entries({ transport: o.transport, worker: o.worker, model: o.model, executable: o.executable,
    timeoutMs: o['timeout-ms'], maxInputBytes: o['max-input-bytes'], minLines: o['min-lines'] }).filter(([, v]) => v !== undefined));
}
async function setup(o) {
  if (o.scope && !['user', 'project'].includes(o.scope)) throw new Error('scope must be user or project');
  if (o.scope === 'project' && o.executable) throw new Error('Executable overrides belong in user settings');
  const modes = o.mode ? [o.mode] : MODES;
  if (modes.some(m => !MODES.includes(m))) throw new Error('mode must be bulk-reader or code-writer');
  const settings = {};
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  try {
    for (const mode of modes) {
      const worker = o.worker || o.host || (rl && (await rl.question(`${mode} worker (claude/codex): `)).trim());
      const model = o.model || (o.host && DEFAULT_MODELS[worker]) || (rl && (await rl.question(`${mode} exact model name: `)).trim());
      if (!worker || !model) throw new Error('Noninteractive setup requires --host, or --worker and --model');
      const flags = { ...overrides(o), worker, model, transport: o.transport || (o.host ? 'auto' : 'cli') };
      if (o.host) await resolveConfig({ host: o.host, mode, flags }); else await loadConfig({ mode, flags });
      settings[mode] = flags;
    }
  } finally { rl?.close(); }
  if (o.host === 'codex') {
    const configs = {};
    for (const mode of modes) {
      const config = await resolveConfig({ host: o.host, mode, flags: settings[mode] });
      if (config.transport === 'native') configs[mode] = config;
    }
    if (Object.keys(configs).length) console.log(`Installed native agents: ${(await installCodexAgents({ configs, scope: o.scope })).join(', ')}. Start a fresh Codex session.`);
  }
  const value = o.host ? { hosts: { [o.host]: { modes: settings } } } : { modes: settings };
  console.log(`Saved ${await saveConfig(value, process.env, o.scope === 'project' ? path.join(process.cwd(), '.openshunt.json') : undefined)}`);
}
async function doctor(o) {
  const results = [];
  for (const mode of MODES) {
    try {
      const config = o.host ? await resolveConfig({ host: o.host, mode, flags: overrides(o) }) : await loadConfig({ mode, flags: overrides(o) });
      if (o.host && config.transport === 'native') {
        if (o.live) throw new Error('Native live checks must run through the parent Agent/spawn_agent tool; doctor will not start a separate CLI session');
        const definition = o.host === 'codex' ? await codexAgentStatus({ mode, model: config.model }) : { ready: true, source: 'bundled Claude plugin agents' };
        if (!definition.ready) throw new Error('Native agent missing or model differs; run setup --host codex and start a fresh session');
        results.push({ mode, transport: 'native', agent: config.agent, model: config.model, definition, live: 'Not run; verify in the host session' });
        continue;
      }
      if (!config.worker || !config.model) throw new Error('Worker/model unset; run openshunt setup');
      const binary = config.executable || config.worker;
      const help = await spawnCapture(binary, config.worker === 'codex' ? ['exec', '--help'] : ['--help'], { timeoutMs: 15000 });
      const required = config.worker === 'codex' ? ['--ephemeral', '--ignore-user-config', '--json', '--sandbox']
        : ['--safe-mode', '--no-session-persistence', '--tools', '--strict-mcp-config', '--output-format'];
      if (help.code !== 0 || required.some(flag => !help.stdout.includes(flag))) throw new Error('CLI is missing required capabilities; upgrade it');
      const auth = await spawnCapture(binary, config.worker === 'codex' ? ['login', 'status'] : ['auth', 'status'], { timeoutMs: 15000 });
      // Only expose a boolean; auth output may contain account identifiers.
      let loggedIn = auth.code === 0;
      if (config.worker === 'claude') { try { loggedIn &&= JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = false; } }
      if (!loggedIn) throw new Error('CLI is not logged in; use its login/auth command');
      let live;
      if (o.live) {
        const response = await runWorker(config, 'Reply with exactly OPENSHUNT_OK. Do not use tools.');
        if (response.text.trim() !== 'OPENSHUNT_OK') throw new Error('Live worker returned an unexpected response');
        live = { passed: true, latencyMs: response.latencyMs, usage: response.usage };
      }
      results.push({ mode, worker: config.worker, model: config.model, capabilities: 'ok', authenticated: true, live });
    } catch (e) { results.push({ mode, error: e.message }); }
  }
  console.log(JSON.stringify({ results, hooks: 'Codex: review and trust the plugin hooks in /hooks (or app hook settings). Installation alone does not trust them. Verify a >350-line read is denied in a fresh session.',
    next: o.host && results.some(r => r.transport === 'native') ? 'Verify native delegation inside the host with Agent/spawn_agent; usage and cancellation are managed by that host.' : o.live ? 'Live worker checks do not prove parent hook integration.' : 'Run doctor --live for a small authenticated request (consumes CLI usage).' }, null, 2));
  if (results.some(r => r.error)) process.exitCode = 1;
}
try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ['--help', '-h'].includes(command)) console.log(HELP);
  else {
    const o = options(argv);
    if (o.help) console.log(HELP);
    else if (command === 'setup') await setup(o);
    else if (command === 'doctor') await doctor(o);
    else if (command === 'savings') {
      const report = await savings();
      console.log(o.json ? JSON.stringify(report, null, 2) : formatSavings(report));
    }
    else if (command === 'stats') console.log(JSON.stringify({ ...await stats(), scope: 'CLI worker calls only. Native subagent usage is reported by the host; OpenShunt does not estimate it.' }, null, 2));
    else if (command === 'resolve') {
      const c = await resolveConfig({ host: o.host, mode: o.mode || 'bulk-reader', flags: overrides(o) });
      console.log(JSON.stringify({ host: c.host, mode: o.mode || 'bulk-reader', transport: c.transport, worker: c.worker, model: c.model, agent: c.agent }, null, 2));
    }
    else if (command === 'publish') console.log(await publishNative({ staged: o.staged, target: o.target, overwrite: o.overwrite, ...(o['max-input-bytes'] ? { maxInputBytes: Number(o['max-input-bytes']) } : {}) }));
    else if (['bulk-read', 'code-write'].includes(command)) {
      const mode = command === 'bulk-read' ? 'bulk-reader' : 'code-writer';
      if (mode === 'code-writer' && !o.reference) throw new Error('--reference is required');
      if (mode === 'bulk-reader' && (o.target || o.overwrite)) throw new Error('bulk-read does not accept --target or --overwrite');
      const config = o.host ? await resolveConfig({ host: o.host, mode, flags: overrides(o) }) : await loadConfig({ mode, flags: overrides(o) });
      if (o.host && config.transport === 'native') {
        console.log(JSON.stringify(await nativeRequest({ host: o.host, mode, task: o.question ?? o.spec, files: mode === 'bulk-reader' ? (o.paths || []) : [o.reference], target: o.target, overwrite: o.overwrite, flags: overrides(o) }), null, 2));
      } else {
      if (config.transport !== 'cli' && !(config.transport === 'auto' && config.worker && config.model) && !o.host) throw new Error('Specify --host for native delegation or --transport cli for an external worker');
      const result = await delegate({ mode, task: o.question ?? o.spec, files: mode === 'bulk-reader' ? (o.paths || []) : [o.reference],
        target: o.target, overwrite: o.overwrite, config });
      process.stdout.write(result.visible + (result.visible.endsWith('\n') ? '' : '\n'));
      process.stderr.write(`OpenShunt ${JSON.stringify({ worker: config.worker, model: config.model, latencyMs: result.record.latencyMs, usage: result.record.usage })}\n`);
      }
    } else throw new Error(`Unknown command: ${command}`);
  }
} catch (e) { process.stderr.write(`OpenShunt: ${e.message}\n`); process.exitCode = 1; }
