# Validation — 2026-09-09

Implemented and tested on macOS with Node 25.9.0, Codex CLI 0.144.5 and Claude Code 2.1.266. Selected workers: `gpt-5.6-luna` and `haiku`.

## Automated checks

- `npm test`: **49 passed**, zero failures. Covers routing, configuration precedence, structured transport, failures, timeout/output bounds, atomic writes, metadata privacy, CLI setup/doctor, and nested-sandbox error classification.
- `npm run check`: manifests, shared hook registration, skills and marketplaces pass.
- Codex plugin manifest validator and all four skill validators pass.
- `npm pack --dry-run` includes both hidden manifests, hooks, runtime, skills, README and license.
- macOS/Linux Node 22/24 CI is configured. The remote CI matrix has not been run from this local checkout.

## Savings command (0.3)

Added the user-facing savings skill and `openshunt savings [--json]`. Tests cover native attempt/read-block counting, duplicate hook IDs, metadata privacy, disabled tracking, corrupt log lines, metadata write failures, provider-specific usage fields, separation of legacy estimates, and CLI source/output-based context estimates. Failed publication does not add a completed call. Native attempts are explicitly not completions; native savings and dollar savings remain unavailable.

The command was exercised through the local CLI with empty and fixture histories. Plugin and skill validators check packaging; interactive slash-menu discovery has not been live-tested for this new skill. Historical live delegation evidence below predates this instrumentation.

## Native subagents (0.2)

Claude Haiku passed all five live checks in 53.53 seconds: parent full-read denial, targeted read, identified child read-hook exemption, correct marker answer, and independently verified atomic publication.

Codex Luna successfully used both native roles inside a **workspace-write parent**, returned the correct marker, and published the exact requested file. Parent hooks denied the full read and permitted the targeted read. However, **the test recorder did not receive child PreToolUse events**, so the strict native acceptance remains incomplete (`passed: false`). Several runs reproduced this, including a normal non-ephemeral parent and removal of inherited desktop control environment. Disabling the code-mode host feature did not establish coverage and was reverted. No workaround weakens host permissions.

The latest recorded Codex run took 81.54 seconds. This is a four-operation integration test with two subagents, not a single-worker latency benchmark. The actual child transcripts verified role instructions and Luna model selection. The children received the task envelope plus host/project instructions, without the parent conversation. Native workers inherit host permissions; the reader role's requested read-only sandbox was not established as a stricter boundary by the observed runtime.

[Native recorded results](evals/native-recorded-results.json) preserve the five checks, latency and aggregate host usage. Codex child-hook coverage, desktop variants without named roles, marketplace discovery and normal hook-trust UI remain unverified. The harness registers Codex roles explicitly; filesystem auto-discovery still needs normal-install acceptance. Native usage includes host overhead and is not isolated per-worker billing. No native savings claim is made.

## Historical 0.1 external CLI parent/worker tests

Each passing row verified full-read denial, targeted-read success, a concise bulk answer and direct-to-disk generation through actual parent tool calls.

| Parent | Worker | Parent permissions | Result |
| --- | --- | --- | --- |
| Claude Haiku | Claude Haiku | Explicit Read/Bash allowlist, dontAsk | Pass |
| Claude Haiku | Codex Luna | Explicit Read/Bash allowlist, dontAsk | Pass |
| Codex Luna | Claude Haiku | workspace-write, network enabled | Pass |
| Codex Luna | Codex Luna | unrestricted parent; worker remains read-only | Pass |
| Codex Luna | Codex Luna | workspace-write, network enabled | Native CLI initialization blocked |

Claude tests loaded the plugin via `--plugin-dir`. Codex tests loaded the shipped hook through inline configuration with a test-only evidence recorder and the documented one-invocation trust bypass for reviewed hooks. No persisted trust was changed. These results do **not** prove the Codex marketplace-install or normal trust-UI flow; normal installation still requires that review.

For the restricted Codex-to-Codex case, the hook and targeted read passed, but both worker invocations failed before model execution with `failed to initialize in-process app-server client: Operation not permitted`. OpenShunt now classifies that error clearly. It does not change permissions or select another model. Do not interpret the unrestricted row as restricted-parent support.

## Historical external CLI worker benchmarks

All eight synthetic scenarios passed the required-symbol checks or execution of generated tests:

| Scenario | Luna latency | Haiku latency |
| --- | ---: | ---: |
| Single large file | 9.72 s | 5.58 s |
| Source/test pair | 7.30 s | 6.23 s |
| Multiple files | 7.61 s | 5.75 s |
| Generate test file | 9.39 s | 6.90 s |

These deliberately simple fixtures produce very small answers. Their large byte-based context reductions are not a general accuracy result, a tokenizer measurement, or a billing reduction. Even an `OPENSHUNT_OK` probe carried substantial native CLI input overhead: Luna reported 11,464 input tokens; Haiku reported 10 input tokens plus 4,944 cache-creation input tokens. Provider usage fields are retained separately rather than treated as interchangeable totals.

[Recorded results](evals/recorded-results.json) contain the sanitized measurements. [Acceptance instructions](evals/ACCEPTANCE.md) explain how to reproduce them. Raw local reports are ignored by Git.

## Delivery status

The source and local marketplace metadata are ready for installation. Nothing has been published to npm/GitHub or installed into the user's persistent host configuration. Worker choices were provided per live test; saved user settings remain unchanged. Native defaults are now Haiku and Luna. Run setup to install Codex roles and save any custom mapping; no persistent role definitions or settings were installed by these tests.
