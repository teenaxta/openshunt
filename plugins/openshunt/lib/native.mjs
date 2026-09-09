import { lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, MODES } from './config.mjs';
import { atomicWrite, checkTarget, stripFence } from './delegate.mjs';

export const DEFAULT_MODELS = { claude: 'haiku', codex: 'gpt-5.6-luna' };
export const AGENTS = {
  claude: { 'bulk-reader': 'openshunt:bulk-reader', 'code-writer': 'openshunt:code-writer' },
  codex: { 'bulk-reader': 'openshunt_bulk_reader', 'code-writer': 'openshunt_code_writer' }
};
export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export function agentMode(type) {
  for (const [host, modes] of Object.entries(AGENTS)) for (const [mode, name] of Object.entries(modes)) {
    if (type === name) return { host, mode };
  }
  return null;
}
export function workerIdentity(event) {
  // --agent on the main session is not an exemption. Require host-supplied child identity.
  return typeof event?.agent_id === 'string' && event.agent_id ? agentMode(event.agent_type) : null;
}
export async function resolveConfig({ host, mode = 'bulk-reader', cwd = process.cwd(), env = process.env, flags = {} }) {
  if (!Object.hasOwn(DEFAULT_MODELS, host)) throw new Error('Native delegation requires --host claude or --host codex');
  const config = await loadConfig({ host, mode, cwd, env, flags });
  const worker = config.worker || host;
  const transport = config.transport === 'cli' || (config.transport === 'auto' && worker !== host) ? 'cli' : 'native';
  if (transport === 'native' && worker !== host) throw new Error('Cross-host delegation requires --transport cli (or auto with an explicit worker)');
  return { ...config, host, worker, transport, model: config.model || DEFAULT_MODELS[worker], agent: AGENTS[host][mode] };
}
export function codexAgentDir({ scope = 'user', cwd = process.cwd(), env = process.env } = {}) {
  if (!['user', 'project'].includes(scope)) throw new Error('scope must be user or project');
  return path.join(scope === 'project' ? path.join(cwd, '.codex') : (env.CODEX_HOME || path.join(homedir(), '.codex')), 'agents');
}
export async function installCodexAgents({ configs, scope, cwd = process.cwd(), env = process.env }) {
  const dir = codexAgentDir({ scope, cwd, env });
  const outputs = [];
  // Validate every destination before writing anything; never overwrite unrelated definitions.
  for (const [mode, config] of Object.entries(configs)) {
    if (!MODES.includes(mode)) throw new Error('Invalid agent mode');
    const name = AGENTS.codex[mode];
    const file = path.join(dir, `${name}.toml`);
    const template = await readFile(path.join(pluginRoot, 'native', 'codex', `${name}.toml`), 'utf8');
    let old;
    try { if (!(await lstat(file)).isFile()) throw new Error(`Refusing nonregular agent file: ${file}`); old = await readFile(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old !== undefined && !old.startsWith('# Managed by OpenShunt\n')) throw new Error(`Refusing to overwrite an unrelated agent: ${file}`);
    const content = '# Managed by OpenShunt\n' + `# openshunt-model: ${JSON.stringify(config.model)}\n` +
      `model = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = "low"\n` + template.replaceAll('__OPENSHUNT_CLI__', path.join(pluginRoot, 'scripts', 'openshunt.mjs'));
    outputs.push({ file, content, exists: old !== undefined });
  }
  await mkdir(dir, { recursive: true });
  for (const { file, content, exists } of outputs) await atomicWrite(file, content, exists);
  return outputs.map(o => o.file);
}
export async function codexAgentStatus({ mode, model, cwd = process.cwd(), env = process.env }) {
  // Project definitions take precedence over user definitions. Walk up to the Git boundary.
  const dirs = []; let dir = path.resolve(cwd);
  while (true) {
    dirs.push(path.join(dir, '.codex', 'agents'));
    try { await lstat(path.join(dir, '.git')); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  dirs.push(codexAgentDir({ env }));
  for (const folder of dirs) {
    const file = path.join(folder, `${AGENTS.codex[mode]}.toml`);
    try {
      const content = await readFile(file, 'utf8');
      const modelLine = content.split('\n').find(l => l.startsWith('model = '));
      let actual;
      try { actual = JSON.parse(modelLine?.slice(8)); } catch {}
      return { ready: content.startsWith('# Managed by OpenShunt\n') && actual === model, path: file, model: actual };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { ready: false };
}
export async function nativeRequest({ host, mode, task, files, target, overwrite = false, cwd = process.cwd(), env = process.env, flags = {} }) {
  const config = await resolveConfig({ host, mode, cwd, env, flags });
  if (config.transport !== 'native') return { transport: 'cli', worker: config.worker, model: config.model };
  const persistent = await resolveConfig({ host, mode, cwd, env });
  if (persistent.transport !== config.transport || persistent.model !== config.model) throw new Error('Native model/transport overrides must be saved with setup (or supplied through environment/project configuration) so hooks use the same selection');
  if (typeof task !== 'string' || !task.trim() || !files?.length) throw new Error('A task and explicit input paths are required');
  if (mode === 'code-writer' && !target) throw new Error('Native code-write requires --target');
  if (host === 'codex' && !(await codexAgentStatus({ mode, model: config.model, cwd, env })).ready) {
    throw new Error(`Codex agent is missing or its model differs; run setup --host codex --model ${config.model}, then start a new session`);
  }
  let bytes = 0;
  const paths = files.map(f => path.resolve(cwd, f));
  for (const file of paths) {
    const stat = await lstat(file); if (!stat.isFile()) throw new Error('Native input paths must be regular files'); bytes += stat.size;
  }
  if (bytes > config.maxInputBytes) throw new Error('Input exceeds byte limit; split the request');
  const resolvedTarget = target && path.resolve(cwd, target);
  if (resolvedTarget) await checkTarget(resolvedTarget, overwrite);
  const staged = resolvedTarget && path.join(path.dirname(resolvedTarget), `.openshunt-${randomUUID()}.stage`);
  return { transport: 'native', host, agent: config.agent, model: config.model,
    context: 'fresh; supply only this task and these paths, never fork the parent history',
    task, paths, ...(resolvedTarget ? { target: resolvedTarget, staged, overwrite, publishCli: path.join(pluginRoot, 'scripts', 'openshunt.mjs') } : {}),
    return: mode === 'bulk-reader' ? 'Concise answer only, no raw file contents' : 'Published target path and validation result only',
    note: 'The parent must invoke its native Agent/spawn_agent tool. This command does not run a worker or consume model tokens.' };
}
export async function publishNative({ staged, target, overwrite = false, maxInputBytes = 1048576 }) {
  if (!staged || !target || path.resolve(staged) === path.resolve(target)) throw new Error('Distinct --staged and --target paths are required');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) throw new Error('maxInputBytes must be a positive integer');
  const stat = await lstat(staged);
  if (!stat.isFile() || stat.size > maxInputBytes) throw new Error('Staged output must be a bounded regular file');
  const bytes = await readFile(staged);
  if (bytes.length > maxInputBytes || bytes.includes(0)) throw new Error('Invalid or oversized staged output');
  const code = stripFence(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  await atomicWrite(path.resolve(target), code, overwrite);
  await unlink(staged).catch(() => {});
  return `Wrote ${target} (${Buffer.byteLength(code)} bytes).`;
}
