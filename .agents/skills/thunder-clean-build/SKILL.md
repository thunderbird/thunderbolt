---
name: thunder-clean-build
description: Remove Thunderbolt build artifacts in the current checkout (make clean - dist, src-tauri/target, node_modules). Use when asked to clean build output or reset a broken build. To remove a finished task's worktree and everything it created, use thunder-cleanup instead.
---

Run `make clean`. It also deletes `node_modules`, so run `make setup` before the next build. Report what was removed.
