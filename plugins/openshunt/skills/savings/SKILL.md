---
name: savings
description: Show locally recorded OpenShunt routing counts, configured worker models, reported CLI usage and estimated parent-context reduction. Use when asked about OpenShunt savings or delegation statistics.
---

Resolve `../../scripts/openshunt.mjs` relative to this skill file and run `node "<resolved-script>" savings --json`. This only reads local metadata; do not launch a worker or inspect conversation transcripts.

Present blocked-read attempts, native delegation attempts, completed CLI calls, and the per-model breakdown. Keep native attempts separate from completions: another permission hook, cancellation or failure can prevent execution after PreToolUse. Do not add blocked reads and attempts into a routed-call total.

Show the CLI context estimate as an approximate byte/4 reduction, not net tokens or money saved. Keep legacy prompt-based estimates separate. Report native savings and monetary savings as unavailable; never invent prices, percentages or a parent-model baseline. No records means no recorded activity, not proof that nothing ran. State that history is local across projects, and routing before this feature cannot be reconstructed.
