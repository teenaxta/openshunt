import { loadConfig } from './config.mjs';
import { route } from './routing.mjs';
import { agentMode, workerIdentity, resolveConfig, codexAgentStatus } from './native.mjs';
import { recordRouting } from './savings.mjs';
const agentTools = ['Agent', 'Task', 'spawn_agent'];
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
export async function handlePreTool(event, env = process.env) {
  if (env.OPENSHUNT_WORKER_ACTIVE === '1' || env.OPENSHUNT_ENABLED === '0') return null;
  const cwd = event.tool_input?.workdir || event.tool_input?.cwd || event.cwd || process.cwd();
  const identity = workerIdentity(event);
  if (identity) {
    if (agentTools.includes(event.tool_name)) return deny('OpenShunt workers cannot delegate recursively. Complete the supplied task directly.');
    const config = await resolveConfig({ ...identity, cwd, env });
    if (config.transport !== 'native') return deny('This OpenShunt mode is configured for CLI transport; return to the parent.');
    if (identity.host === 'codex' && event.model !== config.model) return deny(`OpenShunt worker model mismatch. Expected ${config.model}; rerun setup --host codex and start a fresh session.`);
    if (identity.mode === 'bulk-reader' && ['Write', 'Edit', 'apply_patch'].includes(event.tool_name)) return deny('OpenShunt bulk-reader is read-only.');
    return null; // Only a host-identified OpenShunt worker is exempt from the bulk-read guard.
  }
  if (agentTools.includes(event.tool_name)) {
    const input = event.tool_input || {};
    const selected = agentMode(input.subagent_type || input.agent_type);
    if (!selected) return null;
    const config = await resolveConfig({ ...selected, cwd, env });
    if (config.transport !== 'native') return deny('OpenShunt is configured for CLI transport. Use the skill’s explicit CLI route.');
    if (selected.host === 'claude' && (input.model || 'haiku') !== config.model) {
      return deny(`Use this native subagent with model=${config.model}, as configured in OpenShunt. Do not substitute another model.`);
    }
    if (selected.host === 'codex') {
      if (!(await codexAgentStatus({ mode: selected.mode, model: config.model, cwd, env })).ready) return deny('Run OpenShunt setup --host codex to install/update the selected model’s native agents, then start a new session.');
      if (input.fork_turns !== 'none' && input.fork_context !== false) return deny('OpenShunt needs a fresh subagent context. Use fork_context=false (or fork_turns="none" if exposed by your host); pass only the task and file paths.');
    }
    await recordRouting('native_attempt', event, { ...selected, model: config.model }, env);
    return null; // Do not return "allow": preserve the host's ordinary permission checks.
  }
  const host = event.model !== undefined ? 'codex' : 'claude';
  const config = await loadConfig({ cwd, env, host });
  const reason = await route(event, config);
  if (reason) await recordRouting('read_blocked', event, { host, mode: 'bulk-reader' }, env);
  return reason ? deny(reason + ' Default: delegate to the native OpenShunt bulk-reader agent, not another CLI process.') : null;
}
