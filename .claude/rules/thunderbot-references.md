---
paths:
  - .thunderbot/**
description: "Ensure Thunderbot references are loaded for relevant operations"
---

When executing Thunderbot commands or the Thunderbot agent, always read the relevant reference files from `.thunderbot/references/` based on the current operation:

- Implementation work -> Read `references/implementation.md` and `references/subagent-playbook.md`
- Code review -> Read `references/review.md` (for subagent templates when diff is medium/large)
- PR operations -> Read `references/pr-workflow.md`
- Committing -> Read `references/commit-conventions.md`
- Large tasks -> Read `references/team-orchestration.md`

These references contain critical knowledge that enhances Thunderbot's capabilities. Load them BEFORE starting the relevant work.
