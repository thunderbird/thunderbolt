# Stacked PRs + GitButler: Research Report

> Compiled: February 20, 2026
> Context: Research for adopting stacked PRs in response to large AI-generated PRs becoming a review bottleneck.

---

## Table of Contents

1. [The Problem We're Solving](#1-the-problem-were-solving)
2. [What Stacked PRs Are](#2-what-stacked-prs-are)
3. [Critical Technical Pitfalls](#3-critical-technical-pitfalls)
4. [Review Culture Shift](#4-review-culture-shift)
5. [GitButler: Deep Dive](#5-gitbutler-deep-dive)
6. [The `but` CLI — Full Reference](#6-the-but-cli--full-reference)
7. [GitButler vs. The Competition](#7-gitbutler-vs-the-competition)
8. [Known Issues & Limitations](#8-known-issues--limitations)
9. [What This Means for Our Team](#9-what-this-means-for-our-team)
10. [Sources](#10-sources)

---

## 1. The Problem We're Solving

The data from 2025 is unambiguous. AI coding tools made code generation nearly free — and broke code review.

| Signal | Number | Source |
|---|---|---|
| AI-assisted PRs are larger | **+18%** | Jellyfish / OpenAI |
| PR throughput with AI | **+113% more PRs merged** | Same |
| PR review time with high AI adoption | **+91% increase** | Faros AI (10,000+ devs) |
| Average GitHub PR today | **900+ lines** | Graphite analysis |
| Defect detection on PRs >1,000 lines | **70% lower** | Propel (50,000 PRs) |
| Defect detection on PRs 200–400 lines | **40% fewer defects** | Same |
| Each additional 100 lines | **+25 min review time** | Same |
| Small PRs (<200 lines) | **approved 3× faster** | Same |
| 1 in 7 PRs now involve AI agents | **14%** | Pullflow (40M PRs, 2025) |
| Incidents per PR | **+23.5%** | Cortex 2026 |
| Senior vs. junior AI productivity gap | **5× difference** | Opsera (250,000 devs) |

**The dynamic:** AI makes code generation nearly free, but code review is still linear human work. The entire system now moves at the speed of its slowest link — the reviewer staring at a 1,000-line diff.

From the ["Building An Elite AI Engineering Culture In 2026"](https://www.cjroth.com/blog/2026-02-18-building-an-elite-engineering-culture) article:

> "Reviews of 5 files happen in minutes. Reviews of 50 files take days."

This is Amdahl's Law applied to software delivery. The article explicitly calls stacked PRs the practice that elite teams (Vercel, Snowflake, The Browser Company) adopted to solve this — and notes engineers at those companies maintain **5–10 PR stacks simultaneously**.

---

## 2. What Stacked PRs Are

The concept originated at **Meta** (Phabricator / Arcanist, internally called "stacked diffs") and **Google** (internal tool: Critique). The Graphite founders are ex-Google engineers who built Graphite specifically because they missed Critique after leaving.

### Branch Structure

```
main
 └── stack/refactor          ← PR #1 (targets main)
      └── stack/api          ← PR #2 (targets stack/refactor)
           └── stack/ui      ← PR #3 (targets stack/api)
```

Each PR targets the one **below** it in the stack, not `main`. Reviewers see **only the delta** for that PR — not the accumulated changes from everything underneath.

### The Key Unlock

The developer **does not wait** for PR #1 to be approved before starting PR #2. Work continues up the stack in parallel with review. When a lower PR merges, all PRs above it automatically retarget upward.

### What Elite Teams Do

- Engineers at Vercel, Snowflake, The Browser Company: **5–10 PR stacks simultaneously**
- Asana (Graphite customer): engineers save **~7 hours/week** on code reviews after adopting stacking
- Meta: onboarded as the default development practice from day one
- Stack depth in practice: **3–7 PRs** per stack. Hard limit ~6 — beyond that, rebase cascade risk and reviewer fatigue outweigh the benefits

### The Graphite + Cursor Acquisition (Dec 19, 2025)

Graphite — the leading stacked PRs SaaS tool — was acquired by Cursor for **"way over" its $290M valuation**. Graphite had just raised a $52M Series B backed by Anthropic's Anthology Fund, Figma, and Shopify. Their customers include Shopify, Figma, Snowflake, Ramp, and Robinhood.

This signals that stacked PR workflows are becoming **infrastructure**, not optional tooling. In 2026, Graphite's stacked PR tooling will likely become native to Cursor. GitHub is also building native stack support ([roadmap issue #1218](https://github.com/github/roadmap/issues/1218) — not GA yet).

---

## 3. Critical Technical Pitfalls

### ⚠️ The Squash Merge Problem (Most Common Failure)

When GitHub **squash-merges** PR #1 into main, it creates a synthetic commit. PR #2 still references the original commits from PR #1 — Git doesn't recognize those as "already in main," causing conflicts on rebase.

**The fixes:**

```bash
# Option 1 — change merge strategy to regular Merge (recommended by GitButler)
# Set this in GitHub repo Settings → General → Pull Requests

# Option 2 — rebase after squash merge
git rebase --onto origin/main origin/stack/refactor

# Option 3 — use --fork-point for deeper stacks
git rebase --fork-point origin/main
```

**If your repo uses squash-and-merge, changing this is a prerequisite to adopting stacked PRs.**

### ⚠️ The Cascading Rebase Problem

Any change to a downstack PR requires rebasing every upstack branch. Without tooling this is manual and painful.

**The built-in Git fix (Git 2.38+):**

```bash
# Set globally — a single rebase at the top auto-repositions all intermediate branches
git config --global --add --bool rebase.updateRefs true

# Then one command rebases the entire stack
git checkout stack/ui
git rebase main
```

GitButler handles this automatically.

### CI Cost Multiplication

A stack of 6 PRs = up to 6× CI runs. Each rebase re-triggers them. Factor this in if your pipeline is expensive.

---

## 4. Review Culture Shift

The tooling change is secondary to the cultural change. The human reviewer role needs to transform:

| Old Model | New Model |
|---|---|
| Line-by-line gatekeeper | Editor and architect |
| Reviews everything manually | AI handles first pass (style, simple bugs) |
| PRs sit in queue for days | Each PR reviewed in minutes |
| Review after feature complete | Review each logical layer as it's ready |

**For reviewers in a stacked PR workflow:**
- Review the moment you're tagged — don't wait for downstack PRs to merge first
- Start from the bottom of the stack (closest to `main`) and work upward
- Fast, actionable feedback is critical: a 3-day delay on PR #1 while the author has finished PRs #2–5 creates a painful rebase cascade

**For authors:**
- Open PRs for review as each layer completes — don't wait for the full feature
- Mark PRs as Draft when returning to them after feedback, so reviewers don't re-review a moving target
- Communicate upward when downstack feedback comes in: comment on upstack PRs noting the base is changing

---

## 5. GitButler: Deep Dive

### Background

- **Founded:** 2023 by **Scott Chacon** (GitHub co-founder, wrote the *Pro Git* book) and **Kiril Videlov** (CTO, YC alum, fintech background)
- **Team size:** 9 people
- **HQ:** Berlin (distributed, team in Germany/Sweden/UK)
- **License:** Fair Source (Functional Source License) — source-readable, non-compete clause, converts to MIT after 2 years. Not OSI open source.
- **Pricing:** **Currently free.** No paid tier exists. Server/team product planned as future paid offering.
- **Technology:** Tauri (Rust backend) + Svelte frontend

### The Core Concept: Virtual Branches

GitButler's central innovation has no equivalent in other tools: **multiple branches can be active simultaneously in a single working directory**.

- You designate a **Target Branch** (e.g., `origin/main`) — everything differing from it belongs to a virtual branch
- Individual hunks within a file can be assigned to different branches
- "Apply / unapply" replaces `git checkout` — applying a branch adds its changes; unapplying removes only those changes cleanly
- **The Merge Guarantee:** since you're always working from the merge product of all active branches, you know they'll all merge cleanly before you push

This means you discover integration conflicts **locally, continuously** — not at PR time.

### Stacked Branches (since v0.14, Dec 2024)

GitButler distinguishes two concepts:
- **Virtual Branches** — independent parallel branches (no ordering)
- **Stacked Branches** — dependent branches where each builds on top of the previous

You can have multiple virtual branches each containing their own independent stacks.

**The 9-step workflow:**

1. Within a branch lane, click "+" to create a dependent branch on top of the current one
2. New commits automatically land in the **topmost** branch
3. Drag hunks or files to move changes between branches in the stack
4. Push the **entire stack as one operation** — `but push`
5. Create GitHub PRs **sequentially, bottom-to-top** — `but pr`
6. GitButler auto-injects a **stack status footer** into every PR description
7. Incorporate review feedback via `but absorb` — automatically reassigns hunks to the right commit
8. Merge PRs bottom-up; when the bottom PR merges + branch deletes, GitHub auto-retargets all others
9. Stack is complete when all branches merge

> **Required GitHub setting:** Enable "Automatically delete head branches" in repo Settings → General. Without this, auto-retargeting doesn't trigger.

> **Recommended merge strategy:** Regular **Merge** (not squash, not rebase) for best stacking experience.

### AI + Claude Code Integration

GitButler has an MCP server that integrates directly with Claude Code, Cursor, and VSCode Copilot Agent.

From their blog:
> "With Claude Code's lifecycle hooks, GitButler auto-sorts simultaneous AI coding sessions into separate branches. Write three features, get three clean branches — no conflicts, no worktrees, no hassle."

**How to set it up:** Add the `gitbutler_update_branches` MCP tool in your editor. After Claude Code generates or modifies files, GitButler automatically captures the diff and constructs a properly formatted commit on the right branch.

The **Rules** feature (v0.16+) goes further: define patterns like "changes to `src/ai/**` always go to branch X" — Claude Code generates code, Rules silently sorts it before you even look.

---

## 6. The `but` CLI — Full Reference

Released **February 5, 2026** (v0.19.0). Latest release: **v0.19.3, February 19, 2026** (yesterday). Technical preview — API may change.

**Install:**
```bash
brew install gitbutler
# or from Settings in the desktop app → Install CLI
```

### Complete Command Set

```bash
# ── Setup ──────────────────────────────────────────
but setup          # Initialize GitButler on any existing git repo
but teardown       # Return to vanilla Git branch management

# ── Inspection ─────────────────────────────────────
but status         # All branches + commits + uncommitted changes
but diff           # Show diffs (--tui for interactive TUI)
but show           # Info about a branch or commit

# ── Core Workflow ───────────────────────────────────
but commit         # Commit changes (--ai for AI-generated message)
but stage          # Stage changes to a specific branch
but branch         # Manage branches
but discard        # Remove changes
but resolve        # Resolve commit conflicts
but merge          # Local branch merging

# ── Stacking & Remote ──────────────────────────────
but push           # Push branch/entire stack to remote
but pull           # Pull upstream + auto-update all branches
but pr             # Create/manage GitHub/GitLab PRs for the stack

# ── Rules (Auto-Assignment) ────────────────────────
but mark           # Create rule for auto-assigning files to a branch
but unmark         # Remove all marks from the workspace

# ── The Power Commands ─────────────────────────────
but absorb         # KEY FOR AI WORKFLOWS: auto-assigns every uncommitted
                   # hunk to the most logically appropriate existing commit
but reword         # Edit a commit message
but uncommit       # Move a commit back to uncommitted state
but amend          # Amend an existing commit with new changes
but squash         # Combine two commits
but move           # Reorder commits or move between branches
but pick           # Cherry-pick a commit from an unapplied branch
but rub            # Combine two entities (absorb-style operation)

# ── Safety Net ─────────────────────────────────────
but undo           # Undo the last operation (unlimited undo!)
but oplog          # View full operations history

# ── AI ─────────────────────────────────────────────
but mcp            # Expose MCP server for AI agent integration
but skill install  # Install AI skills/capabilities

# ── Scripting ──────────────────────────────────────
but <any> --json   # All commands support JSON output
but <any> -j       # Short form of --json

# ── Utilities ──────────────────────────────────────
but gui            # Open the desktop GUI
but update         # Update GitButler
but alias          # Manage command aliases
but config         # Configuration
```

### Highlight: `but absorb`

The most important command for AI-heavy workflows. After Claude Code writes a batch of changes across many files, `but absorb`:

1. Analyzes every uncommitted hunk
2. Compares against existing commits in the stack
3. Automatically assigns each hunk to the commit it most logically extends
4. Stages and amends — no manual sorting required

What used to be a 30-minute "ok which commit does this belong to" exercise becomes one command.

---

## 7. GitButler vs. The Competition

### Full Comparison Table

| | **GitButler** | **Graphite (→ Cursor)** | **git-spice** | **Aviator (`av`)** | **spr** |
|---|---|---|---|---|---|
| Approach | Local-first, virtual branches | GitHub-native SaaS | CLI, GH + GL | CLI + merge queue | CLI, commit-per-PR |
| Stacked PRs | Yes (v0.14+) | Yes (core feature) | Yes | Yes | Yes |
| CLI | `but` (Feb 2026, preview) | `gt` (mature) | `gs` (mature) | `av` (mature) | `spr` (archived) |
| Team dashboard | No (planned) | Yes — strong | No | Moderate | No |
| Auto-rebase | Local, client-side | Cloud-managed | Local | Local | Manual |
| PR footer/linking | Yes, auto-injected | Yes | No | No | No |
| Parallel independent branches | **Yes (unique)** | No | No | No | No |
| Unlimited undo | **Yes (oplog)** | No | No | No | No |
| AI / MCP integration | **Yes (MCP server)** | No | No | No | No |
| Cloud dependency | None | Required | None | None | None |
| Pricing | **Free** | Paid SaaS | Free / MIT | Free CLI + paid queue | Free / MIT |
| Used by | AI-heavy devs | Shopify, Figma, Ramp | GitLab teams | Various | Minimalists |
| License | Fair Source | Closed | MIT | MIT | MIT |

### The Honest Tradeoff

**GitButler wins on:** individual developer experience, AI integration, local-first approach, `but absorb`, virtual branches, unlimited undo, free pricing.

**Graphite wins on:** team visibility dashboard, maturity of stacking workflow, auto-restack on push (cloud-managed, seamless), enterprise customers, battle-tested at scale.

For a team using Claude Code heavily, GitButler is the better fit today. If team visibility becomes a blocker (who has what in flight, review queue status), that's when Graphite would make sense — but it requires a paid subscription and cloud relay.

---

## 8. Known Issues & Limitations

### Open GitHub Issues (Stacked PRs)

| Issue | Impact |
|---|---|
| [#7321](https://github.com/gitbutlerapp/gitbutler/issues/7321) | PRs must be created strictly **bottom-to-top** — creating a dependent PR before its base PR exists causes it to target `main` incorrectly |
| [#7398](https://github.com/gitbutlerapp/gitbutler/issues/7398) | Updating the workspace while stacked PRs are active can **collapse the entire stack** into a single branch |
| [#5818](https://github.com/gitbutlerapp/gitbutler/issues/5818) | **Squash-merge detection broken** — if the repo uses squash-and-merge, manual rebase intervention is required after each merge |
| [#8195](https://github.com/gitbutlerapp/gitbutler/issues/8195) | **Can't easily stack on top of a colleague's open PR** — pulling their remote branch and stacking causes a force-push conflict |
| [#8210](https://github.com/gitbutlerapp/gitbutler/issues/8210) | GitLab: broken links in stacked merge request descriptions |
| [#3252](https://github.com/gitbutlerapp/gitbutler/issues/3252) | Bitbucket not yet supported |

### General Limitations

- Cannot mix `git checkout` / `git switch` with GitButler — vanilla Git commands break the workspace
- Butler Review (patch-based code review system) is **paused** — being rebuilt as part of a planned server product
- CLI is in **technical preview** — command names and API may change
- No team dashboard or centralized visibility (planned via server product, no ETA)
- No multi-agent parallel worktree support yet ([#12224](https://github.com/gitbutlerapp/gitbutler/issues/12224))

### Issue #8195 — Important for Team Collaboration

If two engineers are collaborating where Engineer B needs to build on top of Engineer A's unmerged PR: GitButler doesn't handle this smoothly yet. Pulling A's remote branch and stacking B's work on top causes a force-push conflict. This is a workflow gap that Graphite handles better.

---

## 9. What This Means for Our Team

### Why GitButler Is the Right Fit

1. **Claude Code MCP integration** — explicit, documented integration. Claude Code sessions automatically map to branches. Graphite doesn't have this.
2. **`but absorb`** — directly solves the "AI generated 400 lines across 15 files, now what?" problem
3. **Rules** — auto-assign Claude Code output to the right branches based on file patterns
4. **Local, no cloud** — PR orchestration is fully local; repo content never goes to a third party
5. **Free** — no per-seat cost
6. **Founded by GitHub's co-founder** — deep Git expertise backing the tool

### Prerequisites Before Starting

In priority order:

1. **Change merge strategy** from squash-and-merge → regular Merge in GitHub repo Settings
2. **Enable "Automatically delete head branches"** in GitHub repo Settings → General
3. **Set the Git rebase default** globally:
   ```bash
   git config --global --add --bool rebase.updateRefs true
   ```
4. **Set up the MCP server** in Claude Code (see [GitButler MCP docs](https://docs.gitbutler.com/features/ai-integration/mcp-server))

### Workflow for the Team

```bash
# 1. Set up GitButler on your repo
but setup

# 2. Start a feature — it automatically goes in a branch
but status

# 3. After Claude Code generates code, sort it automatically
but absorb

# 4. Create a dependent branch for the next logical unit
but branch -a <target> <new-branch-name>

# 5. Keep building up the stack...

# 6. Push the entire stack
but push

# 7. Create PRs from bottom-to-top
but pr

# 8. Incorporate review feedback on any commit
but absorb   # re-runs — assigns new changes to right commits

# 9. If anything goes wrong
but undo
but oplog    # see full history, pick a checkpoint
```

### Target PR Size

| Size | Effect |
|---|---|
| < 200 lines | Ideal — approved 3× faster, highest defect detection |
| 200–400 lines | Sweet spot — 40% fewer defects than larger PRs |
| > 400 lines | Consider breaking into a stack |
| > 1,000 lines | 70% lower defect detection — avoid |

### The Cultural Ask

The tool adoption is the easy part. The harder part:

- **Reviewers** must review the moment they're tagged, not batch reviews end-of-day
- **Authors** must stop shipping one 1,200-line PR and start thinking in 200-line logical layers
- **The team** must agree on merge strategy (regular Merge, not squash)
- **PR descriptions** matter more — each PR in a stack needs to explain what _this layer_ does, not just "part of feature X"

---

## 10. Sources

### The Article
- [Building An Elite AI Engineering Culture In 2026](https://www.cjroth.com/blog/2026-02-18-building-an-elite-engineering-culture) — cjroth.com

### GitButler
- [Stacked Branches | GitButler Docs](https://docs.gitbutler.com/features/stacked-branches)
- [Introducing the GitButler CLI](https://blog.gitbutler.com/but-cli) — Feb 5, 2026
- [Stacked Branches with GitButler](https://blog.gitbutler.com/stacked-branches-with-gitbutler)
- [CLI Commands Overview](https://docs.gitbutler.com/commands/commands-overview)
- [Butler Flow](https://docs.gitbutler.com/features/virtual-branches/butler-flow)
- [MCP Server](https://docs.gitbutler.com/features/ai-integration/mcp-server)
- [Getting Started With GitButler Agents](https://blog.gitbutler.com/gitbutler-agent-assist)
- [GitButler CLI Is Really Good](https://matduggan.com/gitbutler-cli-is-really-good/) — third-party review
- [gitbutlerapp/gitbutler on GitHub](https://github.com/gitbutlerapp/gitbutler)

### The Graphite → Cursor Acquisition
- [Building the future of software development with Cursor](https://graphite.com/blog/graphite-joins-cursor) — Dec 2025
- [Cursor continues acquisition spree with Graphite deal](https://techcrunch.com/2025/12/19/cursor-continues-acquisition-spree-with-graphite-deal/) — TechCrunch

### Stacked PRs Concept & Data
- [Stacked Diffs (and why you should know about them)](https://newsletter.pragmaticengineer.com/p/stacked-diffs) — The Pragmatic Engineer
- [Stacked diffs and tooling at Meta with Tomas Reimers](https://newsletter.pragmaticengineer.com/p/stacked-diffs-and-tooling-at-meta) — The Pragmatic Engineer
- [Working with stacked branches in git (Part 1)](https://andrewlock.net/working-with-stacked-branches-in-git-part-1/) — Andrew Lock
- [AI-assisted PRs are 18% larger](https://jellyfish.co/blog/ai-assisted-pull-requests-are-18-larger) — Jellyfish
- [The Impact of PR Size on Code Review Quality](https://propelcode.ai/blog/pr-size-impact-code-review-quality-data-study) — Propel
- [Being Nice to Reviewers: Splitting Large PRs in the AI Era](https://seriousben.com/posts/2025-07-splitting-large-prs-ai-era/)
- [Stacked PRs: Code Changes as Narrative](https://aviator.co/blog/stacked-prs-code-changes-as-narrative) — Aviator
- [Evaluating Tools For Stacking](https://graphite.com/docs/evaluating-tools) — Graphite
- [GitHub Roadmap: Pull request stacks [Preview]](https://github.com/github/roadmap/issues/1218)
