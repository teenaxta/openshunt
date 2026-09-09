import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function workerArgs(worker, model) {
  if (worker === 'claude') return ['--print', '--model', model, '--output-format', 'json', '--tools', '',
    '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', 'dontAsk', '--disable-slash-commands'];
  if (worker === 'codex') return ['exec', '--model', model, '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--disable', 'hooks', '--disable', 'plugins',
    '--disable', 'shell_tool', '--disable', 'multi_agent', '-c', 'web_search="disabled"', '--json', '-'];
  throw new Error('worker must be claude or codex');
}
export function spawnCapture(executable, args, { cwd, env = process.env, input = '', timeoutMs = 120000, maxOutputBytes = 4 * 1048576 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let bytes = 0; let failure; let killTimer;
    function signal(sig) { try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch {} }
    function stop(message) {
      if (failure) return;
      failure = new Error(message); signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), 500);
    }
    const timer = setTimeout(() => stop(`Worker timed out after ${timeoutMs}ms`), timeoutMs);
    const onInterrupt = () => stop('Worker interrupted');
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    function cleanup() { clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { stop('Worker output exceeded the limit; split the request'); return; }
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
    });
    child.on('error', () => { cleanup(); reject(new Error(`Could not start ${path.basename(executable)}; check installation and executable setting`)); });
    child.on('close', code => {
      // Kill any surviving descendants on timeout/interruption, even if the leader exited early.
      if (failure) signal('SIGKILL');
      cleanup();
      if (failure) reject(failure); else resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {}); // EPIPE is reported through the exit/result contract.
    child.stdin.end(input);
  });
}
function numericUsage(source = {}) {
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .filter(k => Number.isFinite(source[k]) && source[k] >= 0).map(k => [k, source[k]]));
}
export function parseResult(worker, stdout) {
  if (worker === 'claude') {
    let value;
    try { value = JSON.parse(stdout); } catch { throw new Error('Invalid or truncated Claude JSON result'); }
    if (value.type !== 'result' || value.is_error || value.subtype !== 'success' || (value.stop_reason && value.stop_reason !== 'end_turn')) {
      throw new Error('Claude did not complete successfully; check authentication, model availability, and output limits');
    }
    if (typeof value.result !== 'string' || !value.result.trim()) throw new Error('Claude returned no final result');
    return { text: value.result, usage: numericUsage(value.usage) };
  }
  let events;
  try { events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('Invalid or truncated Codex JSON event stream'); }
  if (events.some(e => ['error', 'turn.failed'].includes(e.type))) throw new Error('Codex worker failed; check authentication and model availability');
  const end = events.findLast(e => e.type === 'turn.completed');
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  if (!end || !messages.length || events.at(-1)?.type !== 'turn.completed') throw new Error('Codex returned no completed final result');
  if (events.some(e => ['command_execution', 'mcp_tool_call', 'collab_tool_call', 'file_change', 'web_search'].includes(e.item?.type))) {
    throw new Error('Codex worker attempted a tool operation; expected a one-shot text response');
  }
  const text = messages.at(-1).item.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Codex returned an empty final result');
  return { text, usage: numericUsage(end.usage) };
}
export function workerFailureMessage(worker, stderr, code) {
  if (worker === 'codex' && /failed to initialize in-process app-server client.*(?:Operation not permitted|Permission denied)/s.test(stderr)) {
    return 'Codex runtime initialization was blocked by the parent sandbox (runtime files or IPC). Use host-approved execution permissions, or explicitly choose another worker. OpenShunt will not change permissions or models automatically.';
  }
  return `${worker} exited with code ${code}; check CLI login, model availability, and run openshunt doctor`;
}
export async function runWorker(config, prompt, { env = process.env } = {}) {
  if (env.OPENSHUNT_WORKER_ACTIVE === '1') throw new Error('Recursive OpenShunt delegation refused');
  if (!config.worker || !config.model) throw new Error('Choose a worker and model with openshunt setup or --worker/--model');
  if (Buffer.byteLength(prompt) > config.maxInputBytes) throw new Error(`Input exceeds ${config.maxInputBytes} bytes; split into smaller batches`);
  const cwd = await mkdtemp(path.join(tmpdir(), 'openshunt-worker-'));
  const childEnv = { ...env, OPENSHUNT_WORKER_ACTIVE: '1', OPENSHUNT_ENABLED: '0' };
  // A one-shot child has its own session. Preserve credential-related environment and CLI homes.
  delete childEnv.CLAUDECODE; delete childEnv.CLAUDE_CODE_ENTRYPOINT; delete childEnv.CODEX_THREAD_ID;
  const start = Date.now();
  try {
    const executable = config.executable?.includes('/') ? path.resolve(config.executable) : (config.executable || config.worker);
    const result = await spawnCapture(executable, workerArgs(config.worker, config.model), { cwd, env: childEnv, input: prompt, timeoutMs: config.timeoutMs });
    if (result.code !== 0) throw new Error(workerFailureMessage(config.worker, result.stderr, result.code));
    return { ...parseResult(config.worker, result.stdout), latencyMs: Date.now() - start };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
