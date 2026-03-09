# Claude Code Skills

Thunderbolt ships with a set of Claude Code slash commands that automate common development tasks. These are the fastest way to get up and running, manage your environment, and ship code.

## Getting Started

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code), then run it from the repo root:

```sh
claude
```

From inside Claude Code, type any of the commands below.

## Environment

### `/thunderup`

Bootstrap the full dev environment in one shot.

```
/thunderup          # install deps, start Docker, verify tools
/thunderup all      # same as above + start dev servers
/thunderup THU-123  # create a worktree for a Linear ticket, then bootstrap
/thunderup my-branch # create a worktree for a branch, then bootstrap
```

What it does:

1. `make doctor-q` — verify required tools (only prints issues)
2. `make setup` — install frontend and backend dependencies
3. `make docker-up` — start Docker containers
4. `make docker-status` — confirm containers are healthy
5. _(with `all`)_ `make run` — start backend (:8000) and frontend (:5173) dev servers

When given a Linear ticket ID or branch name, it creates a git worktree first, then bootstraps inside it.

### `/thunderdown`

Stop all Docker containers for the project.

```
/thunderdown
```

Shows what's running, stops everything, and confirms containers are down.

### `/thunderdoctor`

Run `make doctor` to verify all dev tools and environment files are configured correctly.

```
/thunderdoctor
```

If anything fails, it explains what's missing and provides the exact install command for your platform.

### `/thunderclean`

Remove build artifacts (`dist`, `node_modules`, Rust `target`).

```
/thunderclean
```

## Code Quality

### `/thundercheck`

Run type-checking, linting, and format-checking (`make check`).

```
/thundercheck
```

If anything fails, it suggests the appropriate fix command (`make lint-fix`, `make format`, etc.).

### `/thunderpush`

Stage, commit, and push all current changes in a single command.

```
/thunderpush                    # auto-generates a conventional commit message
/thunderpush added login form   # uses your hint for the commit message
```

What it does:

1. Inspects staged and unstaged changes
2. Stages relevant files by name (never `git add .`)
3. Writes a [conventional commit](https://www.conventionalcommits.org/) message (`feat:`, `fix:`, `refactor:`, etc.)
4. Commits and pushes to the current branch
5. Verifies clean state

Rules: one atomic commit per invocation, never amends, never force pushes, never skips pre-commit hooks. If changes span unrelated concerns, it asks whether to split into multiple commits.

## Work Context

### `/thunderin`

Enter a work context — create a worktree, install deps, or bootstrap the environment.

```
/thunderin my-feature     # create worktree for a branch
/thunderin THU-456        # look up the Linear ticket's branch and create a worktree
/thunderin setup          # install frontend + backend dependencies
/thunderin up             # full bootstrap (doctor, setup, docker)
/thunderin up all         # full bootstrap + dev servers
```

When given a Linear ticket ID, it fetches the ticket's branch name automatically. Reports the worktree path, branch name, and whether it was created from remote or as a new branch.

### `/thunderout`

Leave the current worktree, tear it down, and return to `main`.

```
/thunderout
```

Checks for uncommitted changes and unpushed commits before removing the worktree. Warns and asks for confirmation if work would be lost.

## Automation

### `/thunderbot`

Autonomous coding agent. Give it a Linear task (or let it pick one) and it will implement the feature end-to-end and open a PR.

```
/thunderbot           # auto-select the highest-priority unstarted task
/thunderbot THU-789   # work a specific task
```

Phases:

1. **Prerequisites** — verifies tools, Linear auth, and GitHub auth
2. **Task selection** — fetches and scores candidate tasks, picks the best one
3. **Claim** — marks the task as started and assigns it to itself
4. **Isolated environment** — creates a git worktree with its own Docker stack on unique ports
5. **Explore & spec** — reads the codebase with parallel agents, writes a spec, posts it to Linear
6. **Implement** — writes tests first, implements changes, commits incrementally
7. **Draft PR** — pushes and opens a draft pull request linked to the Linear ticket
8. **Quality checks** — runs `make check`, tests, and the `/simplify` code review skill
9. **Finalize** — marks the PR as ready, requests review, updates Linear status
10. **CI** — watches CI, fixes failures (up to 3 attempts), addresses review comments
11. **Cleanup** — tears down Docker, reports a summary

### `/thunderbot-daemon`

Control a background daemon that continuously polls Linear for tasks and works them using `/thunderbot`.

```
/thunderbot-daemon start    # start polling (every 5 minutes)
/thunderbot-daemon stop     # stop the daemon
/thunderbot-daemon status   # show daemon status and recent activity
```

State is persisted at `~/.claude/thunderbot/daemon.state.json` and logs at `~/.claude/thunderbot/daemon.log`.

## Feedback

### `/thunderfeedback`

Submit feedback about Thunderbolt as a GitHub issue.

```
/thunderfeedback               # prompts for your feedback
/thunderfeedback the sidebar feels cramped on small screens
```

Creates a labeled issue on the Thunderbolt GitHub repo.
