---
disable-model-invocation: true
description: "Bootstrap the dev environment"
---

Bootstrap the Thunderbolt dev environment. Accepts an optional argument via $ARGUMENTS.

**Argument parsing:**

- **Empty (default):** Run the standard bootstrap:
  1. `make doctor-q` — verify tools (only prints issues)
  2. `make setup` — install frontend + backend deps
  3. `make docker-up` — start docker containers
  4. `make docker-status` — confirm containers are healthy

- **`all`:** Run the standard bootstrap above, then also:
  5. `make run` — start backend (:8000) and frontend (:5173) dev servers

- **Matches `THU-\d+`** (Linear ticket): Create a worktree for the ticket branch first using `/thunderin <id>`, then run the standard bootstrap inside that worktree.

- **Anything else** (branch name): Create a worktree for that branch using `/thunderin <branch>`, then run the standard bootstrap inside that worktree.

Run each step sequentially. If `make doctor` reports critical failures, stop and report — don't continue the bootstrap.
