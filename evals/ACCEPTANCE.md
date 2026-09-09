# Parent-host acceptance

Native tests use real authenticated host sessions and account usage. They keep fixtures/configuration in temporary directories and independently inspect the generated file. They do not install the plugin persistently.

```sh
node evals/native-smoke.mjs --host claude --output evals/results/native-claude.json
# First review the production hook and imports, including lib/hooks.mjs and lib/native.mjs:
node evals/native-smoke.mjs --host codex --reviewed-hook --output evals/results/native-codex.json
```

The Claude harness loads the plugin through `--plugin-dir`. Codex loads native roles and a test-only evidence recorder through explicit configuration; it uses `--dangerously-bypass-hook-trust` for that invocation only. This does not bypass sandboxing or approvals, persist trust, or test the marketplace/trust UI. The Codex test uses a normal session because ephemeral parent transcripts may be unavailable to child hook handling. Host-managed transcripts can remain in the host's session store.

A complete native acceptance requires parent full-read denial, targeted-read success, child read-hook evidence with an identified role, the correct marker answer, and exact generated file content. A successful final parent assertion alone is insufficient. Reports preserve failed checks. Test fixtures are deliberately trivial; latency and host usage are not representative net-savings benchmarks.

## Normal installation

Install using the README, run setup for Codex roles, review hooks and restart the host. Confirm the named custom agents are available before proceeding.

1. Create a disposable text file exceeding 350 lines with a unique marker near its end, plus a small reference file.
2. Ask for a full read. Expect denial without the corpus entering parent context.
3. Ask for a three-line targeted read. Expect success.
4. Use bulk-reader for the marker. Inspect the native Agent/spawn_agent call: correct role and model, no parent transcript fork, only the task and paths.
5. Use code-writer to create a new file from the reference. Expect staging/publication inside the child and only a receipt returned. Check the file independently.
6. Confirm another full parent read remains denied after delegation; unrelated subagents must not receive an OpenShunt exemption.
7. Try an unavailable model and an existing target without overwrite. Expect errors, no fallback and no target replacement. Restore the selected model afterward.

Hook routing intentionally permits pipes, flags and unfamiliar shell syntax. Use a standalone `cat file` or untargeted Claude Read for the denial check. Native correctness and permission behavior remain host-dependent; check actual hooks rather than inferring them from a successful answer.

## Retained external CLI tests

```sh
node evals/parent-smoke.mjs --worker claude --model haiku
node evals/parent-smoke.mjs --worker codex --model gpt-5.6-luna
node evals/codex-parent-smoke.mjs --worker claude --model haiku --reviewed-hook
node evals/codex-parent-smoke.mjs --worker codex --model gpt-5.6-luna --reviewed-hook
npm run benchmark -- --worker claude --model haiku
npm run benchmark -- --worker codex --model gpt-5.6-luna
```

These explicitly select CLI transport. The four benchmark scenarios cover a large file, source/test pair, multiple files and generation, with separate worker usage, latency, parent-visible output and deterministic quality checks.

The last parent test is expected to fail when the tested macOS workspace-write sandbox prevents a second Codex CLI from initializing. For an environment already using unrestricted execution, `--parent-sandbox danger-full-access` reproduces the historical unrestricted row. Never interpret that result as proof of restricted-parent support. The worker still uses its own read-only sandbox. See VALIDATION.md for current evidence.
