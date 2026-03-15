---
description: "Sync skills with upstream thunderbot repo"
---

Sync thunderbot skills between this repo and the upstream thunderbot repo via git subtree. The `references/` directory is part of the subtree and syncs automatically alongside commands and agent files.

## Instructions

1. Check if the `thunderbot` git remote exists. If not, ask the user for the remote URL and add it:
   ```bash
   git remote get-url thunderbot
   ```

2. Ask the user what they want to do:
   - **Pull**: Pull latest skills from thunderbot → `git subtree pull --prefix=.thunderbot thunderbot main --squash`
   - **Push**: Push local skill changes back to thunderbot → `git subtree push --prefix=.thunderbot thunderbot main`

3. Run the appropriate command and report the result.

4. After a **pull**, recreate agent symlinks: `make setup-symlinks`
