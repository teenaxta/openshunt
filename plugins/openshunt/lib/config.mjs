import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MODES = ['bulk-reader', 'code-writer'];
export function configDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'openshunt');
}
export function dataDir(env = process.env) {
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'openshunt');
}
async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected an object');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Invalid configuration ${file}: ${e.message}`);
  }
}
export async function projectConfig(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    const file = path.join(dir, '.openshunt.json');
    try { await readFile(file); return file; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Stop at a repository boundary; do not inherit a parent repository's config.
    try { await (await import('node:fs/promises')).lstat(path.join(dir, '.git')); return null; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function positive(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
export async function loadConfig({ cwd = process.cwd(), env = process.env, mode = 'bulk-reader', host, flags = {} } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const user = await readJson(path.join(configDir(env), 'config.json'));
  const projectFile = await projectConfig(cwd);
  const project = projectFile ? await readJson(projectFile) : {};
  // Project files cannot select an executable. Executable overrides are local user/env/CLI settings.
  if (project.executable || Object.values(project.modes || {}).some(m => m?.executable)) {
    throw new Error('Executable paths must be configured in user settings, environment, or command flags');
  }
  const merged = { enabled: true, minLines: 350, timeoutMs: 120000, maxInputBytes: 1048576,
    transport: 'auto', ...user, ...user.modes?.[mode], ...user.hosts?.[host], ...user.hosts?.[host]?.modes?.[mode],
    ...project, ...project.modes?.[mode], ...project.hosts?.[host], ...project.hosts?.[host]?.modes?.[mode] };
  const prefix = `OPENSHUNT_${mode.replaceAll('-', '_').toUpperCase()}_`;
  const mappings = { transport: 'TRANSPORT', enabled: 'ENABLED', minLines: 'MIN_LINES', timeoutMs: 'TIMEOUT_MS', maxInputBytes: 'MAX_INPUT_BYTES', worker: 'WORKER', model: 'MODEL', executable: 'EXECUTABLE' };
  for (const [key, suffix] of Object.entries(mappings)) {
    if (env[`OPENSHUNT_${suffix}`] !== undefined) merged[key] = env[`OPENSHUNT_${suffix}`];
    if (env[prefix + suffix] !== undefined) merged[key] = env[prefix + suffix];
  }
  if (host) for (const [key, suffix] of Object.entries(mappings)) {
    const prefix = `OPENSHUNT_${host.toUpperCase()}_`;
    if (env[prefix + suffix] !== undefined) merged[key] = env[prefix + suffix];
    if (env[prefix + mode.replaceAll('-', '_').toUpperCase() + '_' + suffix] !== undefined) merged[key] = env[prefix + mode.replaceAll('-', '_').toUpperCase() + '_' + suffix];
  }
  Object.assign(merged, flags);
  if (!['auto', 'native', 'cli'].includes(merged.transport)) throw new Error('transport must be auto, native or cli');
  if (![true, false, 'true', 'false', '1', '0'].includes(merged.enabled)) throw new Error('enabled must be true or false');
  merged.enabled = [true, 'true', '1'].includes(merged.enabled);
  for (const key of ['minLines', 'timeoutMs', 'maxInputBytes']) merged[key] = positive(merged[key], key);
  if (merged.worker !== undefined && !['claude', 'codex'].includes(merged.worker)) throw new Error('worker must be claude or codex');
  if (merged.model !== undefined && (typeof merged.model !== 'string' || !merged.model.trim() || merged.model.startsWith('-'))) throw new Error('model must be a nonempty model name');
  if (merged.executable !== undefined && (typeof merged.executable !== 'string' || !merged.executable.trim())) throw new Error('executable must be a path or command name');
  if (host && merged.executable && (project.hosts?.[host]?.executable || project.hosts?.[host]?.modes?.[mode]?.executable)) throw new Error('Executable paths must be local user settings');
  return merged;
}
export async function saveConfig(value, env = process.env, projectFile) {
  const dir = projectFile ? path.dirname(projectFile) : configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Preserve unrelated settings and existing per-mode overrides.
  const file = projectFile || path.join(dir, 'config.json');
  const old = await readJson(file);
  const modes = { ...old.modes };
  for (const [mode, settings] of Object.entries(value.modes || {})) modes[mode] = { ...modes[mode], ...settings };
  const hosts = { ...old.hosts };
  for (const [host, settings] of Object.entries(value.hosts || {})) {
    const hostModes = { ...hosts[host]?.modes };
    for (const [mode, entry] of Object.entries(settings.modes || {})) hostModes[mode] = { ...hostModes[mode], ...entry };
    hosts[host] = { ...hosts[host], ...settings, modes: hostModes };
  }
  await writeFile(file, JSON.stringify({ ...old, ...value, modes, hosts }, null, 2) + '\n', { mode: 0o600 });
  return file;
}
