#!/usr/bin/env node
// Test-only evidence recorder. Forward the production hook's input/output unchanged.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [hook, log] = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const result = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 4000 });
const event = JSON.parse(input);
let decision;
try { decision = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision; } catch {}
appendFileSync(log, JSON.stringify({ agent_id: event.agent_id, agent_type: event.agent_type, model: event.model, selected: event.tool_input?.agent_type || event.tool_input?.subagent_type, fork_context: event.tool_input?.fork_context, fork_turns: event.tool_input?.fork_turns, limit: event.tool_input?.limit, tool: event.tool_name, command: event.tool_input?.command, decision: decision || 'pass', exitCode: result.status }) + '\n', { mode: 0o600 });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
process.exitCode = result.status ?? 1;
