---
name: setup
description: Configure OpenShunt native subagent models, install Codex roles, or explicitly select external CLI workers.
---

Resolve `../../scripts/openshunt.mjs` from this skill directory. Run `node <script> setup --host claude` for Haiku or `node <script> setup --host codex` for gpt-5.6-luna. Use `--model EXACT_MODEL --mode bulk-reader|code-writer` to customize each role. Setup writes host-specific configuration. Codex setup installs managed native agent TOML files into its user agents directory; `--scope project` saves project configuration and installs them into the current project's `.codex/agents`. Start a new Codex session after setup. Claude agents ship in the plugin and Agent calls must pass the configured model.

Run `doctor --host claude|codex` to check configuration. Native doctor does not launch another CLI: verify by asking the parent to delegate a small fixture through its native Agent/spawn_agent tool. Installation does not automatically trust Codex hooks; review them in `/hooks` or the app's hook settings, then confirm a full read exceeding 350 lines is denied and a targeted read is allowed.

For explicit external CLI delegation use `setup --host HOST --transport cli --worker claude|codex --model EXACT_MODEL`; reuse CLI authentication and never copy credentials. CLI mode supports `doctor --host HOST --live` (consumes account usage). A restricted macOS Codex parent may prevent another Codex process from initializing; native delegation avoids that second process, while retaining the parent's permissions.

Configuration precedence: flags, environment, project `.openshunt.json`, user `~/.config/openshunt/config.json`, defaults. Use the savings skill for routing activity and CLI context estimates. Native usage belongs to the host's accounting; `stats` records only external CLI calls and labels estimates separately. Native timeout, cancellation and context compaction belong to the host; CLI timeout and input ceiling remain configurable.
