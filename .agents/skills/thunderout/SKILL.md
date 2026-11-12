---
name: thunderout
description: Leave the current Thunderbolt worktree and remove it with everything it created, returning to the main checkout. Use when done with a worktree, or asked to leave or exit it ("sair da worktree").
---

Run the `thunder-cleanup` skill with no argument, which targets the current worktree. It checks
for uncommitted or unpushed work, lists everything it will remove, asks once, removes it and
leaves you in the main checkout. In a harness without skill invocation, read
`.agents/skills/thunder-cleanup/SKILL.md` and follow it.
