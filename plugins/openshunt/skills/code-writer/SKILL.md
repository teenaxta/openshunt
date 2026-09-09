---
name: code-writer
description: Delegate complete new file generation from an explicit reference to a configured smaller native subagent. Use OpenShunt for bounded tasks.
---

Resolve `../../scripts/openshunt.mjs` relative to this skill file. From the project directory run:

```sh
node "<plugin-root>/scripts/openshunt.mjs" code-write --host <claude-or-codex> --spec "Create a new module matching the reference" --reference example.ts --target new-module.ts
```

Select the host you are running in. Supply explicit paths; never read or assemble the corpus in the parent. The default command returns a task envelope, without starting another CLI or consuming model tokens. Invoke the host's native delegation tool with that envelope:

- Claude: `Agent`, `subagent_type` set to the returned agent, `model` set to the returned model, `run_in_background: false`. Supply only the returned task, paths and output instructions in `prompt`.
- Codex: `spawn_agent`, `agent_type` set to the returned agent, fresh context (`fork_context: false`, or `fork_turns: "none"` when that is the exposed schema). Supply only the envelope as the task. Wait for completion. Setup installs the exact model into the role definition; never substitute a different role or model.

If the host exposes no named Agent/subagent_type or spawn_agent/agent_type support, stop with a compatibility explanation. Do not invent tool parameters, use an unrelated worker role, or silently launch a CLI. Offer the supported Codex CLI host or explicit CLI transport.

Native defaults are Claude Haiku and Codex gpt-5.6-luna. Run the setup skill if Codex roles are missing or models differ. Native workers read the files directly and must not delegate again. Hooks exempt only host-identified OpenShunt workers. Native agents still receive host/project instructions and inherit host permissions; their context is not identical to an isolated CLI worker.

An explicitly configured CLI transport executes the worker inside the script and returns its result directly. Cross-host work requires CLI transport. Never launch a second CLI to work around failed native delegation without an explicit CLI selection.

Keep debugging, architecture, safety-critical reasoning and existing-code edits in the parent. Summaries are navigation aids: inspect targeted source before editing. On failure report the error, split the batch or use targeted reads. Do not silently disable the guard or change models. An explicit user-requested bypass is `OPENSHUNT_ENABLED=0` in the parent environment.

Native generation requires a target. Tell the worker to read the reference, write complete output only to the returned staging path, and call the returned publish CLI to publish it atomically. Pass `--overwrite` only when the envelope explicitly permits it. Return only the published path and brief completion metadata. The parent should validate the resulting file. Native staging protects against interrupted writes before publication; it cannot mechanically detect syntactically valid but semantically incomplete code. CLI transport also supports code on stdout when no target is supplied.
