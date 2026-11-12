# Agent skills

These are the project's agent skills, written in the [Agent Skills](https://agentskills.io) format. Codex, Cursor, Gemini CLI, OpenCode and GitHub Copilot read them from this folder. Claude Code reads them through the symlinks in `.claude/skills/`.

## Using a skill

In Claude Code, type `/<name>`. In Codex, type `$<name>`. In the other agents, ask for the skill by name. Every agent can also pick a skill on its own when your request matches the skill's description.

Two skills run only when you name them, because they act without supervision or change the shipped model catalog: `thunderbot-daemon` and `thunder-update-model`.

## The skills

### Local environment

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunderup` | Sets up the dev environment: checks your tools, installs dependencies and starts the Docker stack. With `all` it also starts the backend and Vite. Given a ticket or a branch, it creates a worktree first. | make, Docker, bun |
| `thunderdown` | Stops this checkout's containers. The data volumes are kept. | make, Docker |
| `thunderdoctor` | Runs `make doctor` and explains how to install whatever is missing. | make |
| `thundercheck` | Runs the type, lint and format checks and fixes what fails. | make, bun |
| `thunderclean` | Deletes build output in the current checkout: `dist`, `src-tauri/target` and `node_modules`. | make |

### Worktrees and cleanup

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunderin` | Creates or reuses a worktree for a `THU-n` ticket or a branch. It can also install dependencies or start the stack inside it. | git, the `linear` CLI for tickets |
| `thunder-cleanup` | After a PR merges, removes what its task left on the machine: the worktree, the local branch, Docker containers and volumes, simulators it created, build caches and validation scratch. It lists everything with sizes and asks once before deleting. `merged` cleans every worktree whose PR has merged. It never touches other worktrees, shared caches or agent conversation history. | git, gh, Docker |
| `thunderout` | Leaves the current worktree by running `thunder-cleanup` on it. | as `thunder-cleanup` |

### Commits and pull requests

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunderpush` | Stages files by name, writes a conventional commit and pushes. `AGENTS.md` requires it for every commit. | git |
| `thunderfix` | Gathers the open review threads, PR comments and failing CI on the current PR, fixes them in one batch and waits for CI. Then it replies to and resolves each thread. | gh, bun |
| `thunderfeedback` | Turns your feedback into a GitHub issue labeled `feedback`. Issues are public, so it asks before posting. | gh |

### Review and security

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunder-deep-review` | Reviews a PR or branch against the house rules and the 80 architecture invariants, and reports findings without editing code. It chooses which review lanes to run from the changed files. CI runs it on every PR through `.github/workflows/thunder-deep-review.yml`. | an agent that can start subagents (it falls back to slower sequential passes) |
| `thunderimprove` | Runs `thunder-deep-review` on your branch. If you ask, it applies the findings that have an obvious fix and runs the checks again. | as `thunder-deep-review` |
| `thunder-red-team` | Tries to break the end-to-end encryption claims in `docs/internals/architecture/e2ee-threat-model.md`. It can sweep every area, run one pass, turn a finding into an executable attack spec, or attack a running local stack. | a local stack for live attacks, Playwright for attack specs |

### Validation and performance

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunder-validate` | Runs the app and checks a flow, fix, PR, ticket or the whole app on web, macOS desktop, iOS simulator or Android emulator. It reports PASS, FAIL or BLOCKED for each check on each platform. When the target is new work, it then tries to break it with edge cases. | Docker, bun, Playwright; Xcode for iOS; the Android SDK for Android; native Computer Use for desktop. `playwright-cli`, Argent and `validate-locally` are used when installed. |
| `thunder-performance` | Measures responsiveness, CPU and memory with the production browser harness in `scripts/performance/`, and compares a change against a baseline build. | bun, Chrome Stable |

### Autonomous work

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunderbot` | Takes a Linear task from claim to a reviewed PR: worktree, isolated Docker stack, spec, plan, implementation, draft PR, then CI and review fixes. The Linear labels it reads are the core team's workflow. | the `linear` CLI, gh, Docker, bun |
| `thunderbot-daemon` | Starts, stops or checks a background process that polls Linear and runs `thunderbot` on each new task through Claude Code with every permission check turned off. Run it only on a disposable machine, and read the warning in its `SKILL.md` first. | Claude Code, the `linear` CLI, gh, bun |

### Product changes

| Skill | What it does | Needs |
| --- | --- | --- |
| `thunder-update-model` | Replaces a built-in model in the catalog end to end and hands back a branch ready for `thunderpush`. | gh, git |

## Cleanup ledger

When a skill creates something outside the worktree, such as a repo snapshot, a Docker Compose project or a simulator, it records it with `.agents/skills/thunder-cleanup/scripts/record.sh`. The record goes to a ledger under `.git/thunder-resources/` in the main checkout, one file per worktree path. Git does not track it, and it survives the worktree's removal. `thunder-cleanup` reads it to know what the task owns. A new skill that creates such things should record them the same way.

## Adding a skill

1. Create `.agents/skills/<name>/SKILL.md`. Use only `name` and `description` in the frontmatter, and put the phrases that should trigger the skill in `description`.
2. Link it for Claude Code: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
3. Add `!.claude/skills/<name>` to `.gitignore`. Without it the link stays untracked.
4. Do not name a model. When the skill asks the user something, delegates, uses a worktree or runs work in parallel, add a "Harness notes" table like the one in `thunder-update-model`.
5. To make it run only when named, add `disable-model-invocation: true` to the frontmatter and an `agents/openai.yaml` with `policy: { allow_implicit_invocation: false }` for Codex.
6. Add a row to this README.
