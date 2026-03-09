# thunderbot

Thunderbot is an Autonomous coding agent using Claude Code that helps us build Thunderbolt, an AI client from the Thunderbird team (coming soon). It uses the following workflow - most steps correspond to commands that are useful for human engineers, too:

1. Checks that it has all necessary tools and that they are authenticated
2. Checks who the current git author is
3. Finds a task in Linear that it thinks it can handle
4. Assigns the task to itself
5. Creates a worktree for a new branch (or existing)
6. Spins up the dev environment in Docker
7. Launches 2-3 subagents that explore the task and codebase
8. Generates a detailed plan / spec
9. Updates Linear ticket with its plan
10. Works on the task
11. Reviews and improves its code quality (/thunderimprove - our version of Claude's /simplify)
12. Checks for and fixes any security issues with /security-review (Claude built-in skill)
13. Creates clean, conventional, atomic commits
14. Submits a PR
15. Monitors the PR for comments and failures
16. Fixes any comments or failures
17. Repeats steps 15-16 until everything is done
18. Cleans up and outputs a report
19. Goes back to step 1 (in daemon mode)

## Ideal Tasks
Thunderbot is good at well-scoped tasks where it can establish a feedback loop to check its work. This tends to be straightforward features, bugs, and anything where automated tests are able to give it clear feedback on whether the task was done correctly. With Claude's /chrome feature, it is able to handle browser-based debugging and feedback very well as long as it is clearly able to tell whether the task was completed properly.

## Safety
- We recommend running this inside of a Docker container or VM and then giving it --dangerously-skip-permissions. This way it does not need to constantly stop and ask for permission to do things but has a limited blast-radius when things go wrong.
- It operates using CLI tools, so you'll need to set up those tools for it by logging in or setting API keys for them. You should create accounts or API keys for it that have limited permissions. For example, it should not have the ability to push to the main branch on GitHub. Treat it like an open-source contributor.

Reusable [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills for development workflows. Use them as-is or customize them for your project.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbot/main/setup.sh | bash
```

Run this from your project root. It adds thunderbot as a git subtree, creates symlinks into `.claude/commands/`, and commits the result.

## Tools

thunderbot skills are built on top of these CLIs:

| Tool | What it's used for |
|------|-------------------|
| [git](https://git-scm.com/) | Version control, subtrees, worktrees |
| [gh](https://cli.github.com/) | GitHub PRs, issues, CI checks |
| [linear](https://github.com/linear/linear-cli) | Linear issue tracking |
| [make](https://www.gnu.org/software/make/) | Build automation (`doctor`, `setup`, `check`, etc.) |
| [docker](https://docs.docker.com/get-docker/) | Containerized dev environments |
| [bun](https://bun.sh/) | JavaScript runtime and package manager |
| [jq](https://jqlang.github.io/jq/) | JSON processing |
| [curl](https://curl.se/) | HTTP requests (setup script) |

## Skills

| Skill | Description |
|-------|-------------|
| `thunderbot` | Autonomous coding agent for Linear tasks |
| `thunderbot-daemon` | Background daemon that polls Linear for tasks |
| `thundercheck` | Run type-checking, linting, and format-checking |
| `thunderclean` | Remove build artifacts |
| `thunderdoctor` | Verify dev tools and environment |
| `thunderdown` | Stop docker containers |
| `thunderfeedback` | Submit feedback as GitHub issues |
| `thunderfix` | Fix PR issues and monitor until clean |
| `thunderimprove` | Review changed code for quality |
| `thunderin` | Enter a work context (worktree, deps, bootstrap) |
| `thunderout` | Leave worktree and return to main |
| `thunderpush` | Stage, commit, and push changes |
| `thundersync` | Sync skills with upstream thunderbot |
| `thunderup` | Bootstrap the dev environment |

### Manual Install

If you'd rather do it yourself:

```bash
# Add the remote
git remote add thunderbot git@github.com:thunderbird/thunderbot.git

# Add as a subtree
git subtree add --prefix=.thunderbot thunderbot main --squash

# Create symlinks so Claude Code discovers the commands
mkdir -p .claude/commands .claude/agents
for f in .thunderbot/thunder*.md; do ln -sf "../../$f" ".claude/commands/$(basename $f)"; done
ln -sfn ../../.thunderbot/thunderbot .claude/commands/thunderbot
ln -sf ../../.thunderbot/thunderbot.md .claude/agents/thunderbot.md
```

Make sure `.claude/commands/` and `.claude/agents/` (and their contents) are not gitignored. If your `.gitignore` has `.claude/**`, add exceptions:

```gitignore
.claude/**
!.claude/commands/
!.claude/commands/**
!.claude/agents/
!.claude/agents/**
```

## Pull & Push

**Pull latest changes:**

```bash
git subtree pull --prefix=.thunderbot thunderbot main --squash
```

After pulling, re-run your symlink setup (the setup script creates a `make setup-symlinks` target for this).

**Push local edits back upstream:**

```bash
git subtree push --prefix=.thunderbot thunderbot main
```

## Customization

The symlinks in `.claude/commands/` point to `.thunderbot/`. To customize a command for your project only:

1. Delete the symlink
2. Copy the file from `.thunderbot/` into `.claude/commands/`
3. Edit freely — your version won't be overwritten by `subtree pull`

```bash
rm .claude/commands/thunderfix.md
cp .thunderbot/thunderfix.md .claude/commands/thunderfix.md
# now edit .claude/commands/thunderfix.md
```

To go back to the upstream version, re-create the symlink:

```bash
ln -sf ../../.thunderbot/thunderfix.md .claude/commands/thunderfix.md
```

## FAQ

**Q: Why `.thunderbot/` instead of directly in `.claude/commands/`?**

If the subtree lives at `.claude/commands/`, then *everything* in that directory is owned by the subtree. Any project-specific commands you add there get pushed to the thunderbot repo on `subtree push`. Using `.thunderbot/` as the subtree prefix keeps thunderbot files separate, and symlinks bridge them into `.claude/commands/` where Claude Code expects them.

**Q: Do I need to re-run symlink setup after pulling?**

Yes. If thunderbot adds a new command, you need new symlinks. Run your symlink setup after every pull. The setup script adds a `make setup-symlinks` target and wires it into `make thunderbot-pull` automatically.

**Q: Will `git clone` preserve the symlinks?**

Yes. Git tracks symlinks natively. Anyone who clones the repo gets working symlinks without running any setup.

**Q: Can I add my own commands alongside thunderbot's?**

Yes. Create `.md` files directly in `.claude/commands/` (not as symlinks). They're your project's files and won't interfere with the thunderbot subtree in `.thunderbot/`.

**Q: What if I customize a command and thunderbot updates it upstream?**

Your custom copy in `.claude/commands/` is a regular file, not a symlink — `subtree pull` updates `.thunderbot/` but won't touch your copy. You can diff the two versions and merge manually if you want the upstream changes.

**Q: How do I contribute a new skill back to thunderbot?**

Edit the file in `.thunderbot/`, commit, and push with `git subtree push --prefix=.thunderbot thunderbot main`. Or fork the thunderbot repo and open a PR.
