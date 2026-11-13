---
name: thunder-up
description: Bootstrap the Thunderbolt dev environment - doctor, dependencies, Docker stack and health check; with `all` it also starts the backend and Vite; with a THU-n ticket or branch it creates a worktree first. Use when setting up the project, starting the local stack, or getting the app running.
---

Bootstrap the Thunderbolt dev environment. The argument is the text after the skill name.

- **Empty (default)**: the standard bootstrap, in order:
  1. `make doctor-q`: verify tools (prints only issues)
  2. `make setup`: install frontend and backend dependencies
  3. `make up`: start the containers
  4. `make status`: confirm the containers are healthy
- **`all`**: the standard bootstrap, then `make run` to start the backend (:8000) and Vite (:1420). `make run` first kills whatever listens on those ports. Vite is pinned to 1420 with `strictPort` because Tauri expects a fixed port; 5173 is only the port ThunderBot's isolated Docker stack publishes.
- **Matches `THU-\d+`, or any other text (a branch name)**: create the worktree with the `thunder-in` skill, then run the standard bootstrap inside it.

Run the steps in order. If `make doctor-q` reports a critical failure, stop and report instead of continuing.
