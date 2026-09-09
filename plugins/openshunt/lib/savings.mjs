import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from './config.mjs';

// Persist only these metadata fields. Never serialize the hook payload, task or paths.
export async function recordRouting(kind, event, selection = {}, env = process.env) {
  if (env.OPENSHUNT_TRACKING === '0') return;
  const key = event.session_id && event.tool_use_id
    ? createHash('sha256').update(JSON.stringify([event.session_id, event.tool_use_id, kind])).digest('hex') : undefined;
  const record = { version: 1, timestamp: new Date().toISOString(), kind, key,
    host: selection.host, mode: selection.mode, model: selection.model };
  try {
    const dir = dataDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(dir, 'routing.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch { process.stderr.write('OpenShunt: could not save routing metadata.\n'); }
}
async function rows(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; }
    catch { return []; }
  });
}
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
export async function savings(env = process.env) {
  const [routing, usage] = await Promise.all([
    rows(path.join(dataDir(env), 'routing.jsonl')), rows(path.join(dataDir(env), 'usage.jsonl'))
  ]);
  const seen = new Set();
  const observed = routing.filter(r => {
    if (!['read_blocked', 'native_attempt'].includes(r.kind)) return false;
    if (!r.key) return true;
    if (seen.has(r.key)) return false;
    seen.add(r.key); return true;
  });
  const completed = usage.filter(r => ['bulk-reader', 'code-writer'].includes(r.mode) && typeof r.worker === 'string' && typeof r.model === 'string');
  const groups = new Map();
  function group(transport, host, model, mode) {
    const key = JSON.stringify([transport, host, model, mode]);
    if (!groups.has(key)) groups.set(key, { transport, worker: host, model, mode, attempts: transport === 'native' ? 0 : null, completed: transport === 'cli' ? 0 : null, reportedUsage: {} });
    return groups.get(key);
  }
  for (const r of observed.filter(r => r.kind === 'native_attempt')) group('native', r.host, r.model, r.mode).attempts++;
  for (const r of completed) {
    const g = group('cli', r.worker, r.model, r.mode); g.completed++;
    for (const [key, value] of Object.entries(r.usage || {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) g.reportedUsage[key] = (g.reportedUsage[key] || 0) + value;
    }
  }
  // Legacy records used prompt bytes (including instructions). Keep them separate.
  const measured = completed.filter(r => r.contextEstimateVersion === 1);
  const allTimestamps = [...observed, ...completed].map(r => r.timestamp).filter(t => typeof t === 'string' && Number.isFinite(Date.parse(t))).sort();
  return {
    scope: 'All locally recorded history across projects; not this conversation alone.',
    firstRecordedAt: allTimestamps[0] || null,
    blockedReadAttempts: observed.filter(r => r.kind === 'read_blocked').length,
    nativeDelegationAttempts: observed.filter(r => r.kind === 'native_attempt').length,
    completedCliCalls: completed.length,
    byModel: [...groups.values()],
    contextSavings: {
      estimatedTokensExcluded: measured.reduce((n, r) => n + number(r.estimatedParentInputTokensAvoided), 0),
      measuredCliCalls: measured.length,
      legacyEstimatedTokens: completed.filter(r => r.contextEstimateVersion !== 1).reduce((n, r) => n + number(r.estimatedParentInputTokensAvoided), 0),
      method: 'Per successful CLI call: max(0, bulk source bytes or generated-to-disk bytes minus parent-visible result bytes) / 4, rounded up. Excludes model/skill/tool overhead; not net savings.',
      native: 'Unavailable: native completion, returned bytes and worker usage are not reliably recorded.'
    },
    moneySaved: null,
    limitations: [
      'Native attempts passed OpenShunt PreToolUse checks; the host may still deny, fail or cancel them. They are not completed calls.',
      'Blocked reads and native attempts are separate observations, not additive routed-call totals. Duplicate hook IDs are deduplicated when available.',
      'Reported CLI usage stays grouped by provider/model; cache and token fields are not interchangeable.',
      'Money and net token savings need a parent-model baseline, worker costs, caching and overhead. No dollar or percentage savings are inferred.',
      'History before routing tracking was added cannot be reconstructed. Hook coverage and disabled/failed tracking can undercount.'
    ]
  };
}
export function formatSavings(report) {
  const n = value => value.toLocaleString('en-US');
  const lines = ['OpenShunt savings', report.scope, '',
    `Blocked full-read attempts: ${n(report.blockedReadAttempts)}`,
    `Native delegation attempts: ${n(report.nativeDelegationAttempts)} (completion unverified)`,
    `Completed CLI calls: ${n(report.completedCliCalls)}`, '', 'Recorded worker models:'];
  for (const g of report.byModel) lines.push(`  ${g.transport} / ${g.worker} / ${g.model} / ${g.mode}: ${g.transport === 'native' ? `${n(g.attempts)} attempts` : `${n(g.completed)} completed`}`);
  if (!report.byModel.length) lines.push('  No recorded delegations yet.');
  lines.push('', `Estimated parent context excluded (CLI only): ~${n(report.contextSavings.estimatedTokensExcluded)} tokens across ${n(report.contextSavings.measuredCliCalls)} measured calls.`,
    `Legacy prompt-based estimate (separate): ~${n(report.contextSavings.legacyEstimatedTokens)} tokens.`,
    'Native context savings: unavailable.', 'Money saved / net token savings: not measured.', '',
    report.contextSavings.method, 'Native attempts are not completed calls; do not add them to blocked reads.');
  for (const g of report.byModel.filter(g => g.transport === 'cli')) lines.push(`Reported usage [${g.worker}/${g.model}/${g.mode}]: ${JSON.stringify(g.reportedUsage)}`);
  lines.push('Tracking starts when installed; missing hook coverage or disabled tracking can undercount.');
  return lines.join('\n');
}
