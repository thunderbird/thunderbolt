# AI Code Review (`thunder-deep-review`)

Every non-draft pull request opened from a branch in this repository (Dependabot excepted) gets an automated review
from `thunder-deep-review`. It arrives as inline review comments authored by `github-actions[bot]`, under a review
body headed "🔭 thunder-deep-review (advisory)". This page explains what produces those comments, what they can and
cannot do to your PR, and how to run the same reviewer locally before you push.

## It is advisory, and that is a design constraint

The review is posted with `event: 'COMMENT'` — the only event the orchestrator ever sends
(`.github/scripts/review-orchestrator.mjs:1301`, `:1316`, `:1361`). It never approves, never requests changes, and
never merges. Human approval and merge stay exactly where they were. If a finding is wrong, say so in the thread
and move on; resolving the thread yourself is respected (see [Convergence](#convergence-across-pushes)).

The whole pipeline is **fail-soft**: on any unrecoverable error the orchestrator logs and exits 0 without posting
(`review-orchestrator.mjs:158`). A missing review is acceptable; a broken or duplicated one is not. The next push
retries.

Because it never gates anything, treat a finding as review feedback rather than as a CI failure — this is also how
`/thunderfix` handles it (see [`.thunderbot/thunderfix.md`](../../.thunderbot/thunderfix.md)).

## When it runs

`.github/workflows/thunder-deep-review.yml` triggers on `pull_request` with types
`opened, synchronize, reopened, ready_for_review` (`:30`). The job `if:` (`:55`) then hard-gates on three
conditions:

- **Same-repo PRs only.** `head.repo.full_name == github.repository`. Fork PRs are gated off entirely, because the
  job needs the `ANTHROPIC_API_KEY` repo secret and fork code must never run with access to it. The workflow header
  (`:31-34`) explicitly warns against "fixing" this by switching to `pull_request_target` plus a checkout of the
  fork head — that is the pwn-request key-exposure pattern. Fork coverage, if ever wanted, has to be a separate
  metadata-only `workflow_run` job.
- **Not Dependabot.**
- **Not a draft.** `ready_for_review` is in the trigger list so un-drafting starts a review.

The first step is a 60-second `sleep` (`:102`), paired with `cancel-in-progress` concurrency keyed on the PR number
(`:42-47`). Rapid pushes — a rebase, a typo fix — cancel each other during that debounce at zero model cost. The
job is capped at `timeout-minutes: 30` (`:69`), which is the real guard on a hung model call.

Permissions are the three scopes the mechanism needs and nothing more: `contents: read`, `pull-requests: write`,
`checks: read` (`:37-40`). Without `checks: read` the bot poller 403s.

## Two model steps: recall, then a precision gate

The interesting part of the design is that there are **two** model steps with opposite jobs.

1. **Recall pass** (`:197`) runs the `thunder-deep-review` skill at `--effort xhigh` with a 40-turn budget and
   deliberately over-generates _candidate_ findings, including ones it is unsure about.
2. **Precision gate** (`:403`) is a second, narrower step at `--effort high` with 12 turns whose only job is to
   decide which candidates a senior engineer would actually leave in a real review. It **defaults to drop** and is
   explicitly told that returning `{"findings":[]}` is a successful review.

Splitting recall from precision is the fix for the "always finds something" failure mode that single-pass review
bots have. A high-recall pass on its own buries real bugs in noise; a single pass tuned for precision misses
things. The gate may also **demote** a real-but-minor finding's severity (`blocking → convention → nit`) instead of
dropping it, but it may never raise one, and when demoting it must leave every other field byte-for-byte verbatim.

The gate is **skipped entirely** when the recall pass produced zero candidates — empty in can only yield empty out,
so a second model call would be pure spend.

Both steps are strictly read-only: `--allowedTools Read,Grep,Glob,Skill,Task,Agent` for the recall pass (`:252`)
and `Read,Grep,Glob` for the gate (`:426`). No `Bash`, no write tools. The recall pass therefore cannot write its
own output file — it returns findings as the action's `structured_output` against a `--json-schema`, and a separate
shell step materializes that to disk.

That persist step **fails loudly** on an empty `structured_output`: a cancelled or errored model step has to be a
red check, never a silent green no-op that the gate would launder into a fake "no issues". A genuinely clean
result arrives as the non-empty string `{"findings":[]}`.

## Orchestration is deterministic code, not model tool-calls

The model does **no** GitHub I/O. All of it lives in `.github/scripts/review-orchestrator.mjs`, which runs in two
phases around the model steps and has zero npm dependencies (built-in `fetch` only):

| Phase  | Step                                                                             | What it does                                                                                                     |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pre`  | [`thunder-deep-review.yml:154`](../../.github/workflows/thunder-deep-review.yml) | Polls the external review bots, builds the skip-list, reconstructs the unified diff, computes the deep-mode flag |
| `post` | [`thunder-deep-review.yml:538`](../../.github/workflows/thunder-deep-review.yml) | Validates the model JSON, anchors findings to diff lines, dedups, resolves fixed threads, posts one PR review    |

Two consequences worth knowing:

- **The diff is rebuilt from the Files API, not `git diff`.** The `Accept: v3.diff` media type caps at 20,000 lines
  / 1 MB and returns 406 on large PRs, which used to hard-fail the whole job. The orchestrator paginates
  `/pulls/{n}/files` instead and reassembles the patch (`buildUnifiedDiff`, `review-orchestrator.mjs:878`). That
  endpoint returns the same merge-base..head set that `POST /pulls/{n}/reviews` validates inline comment anchors
  against, so findings land on the right line. A local two-dot `base..head` diff would use base's _current_ tip and
  inject base-only commits as reverse diffs, which 422s the review.
- **Everything reconciles to the PR head SHA**, never the synthetic merge ref, so the poller and the diff describe
  the same code.

The orchestrator is unit-tested (`.github/scripts/review-orchestrator.test.mjs`) and that suite runs as part of
`bun run test` (see the `test` script in `package.json`).

## Sequencing behind the external bots

Cursor Bugbot reviews the same PRs and is the one external reviewer registered in the orchestrator's
`EXPECTED_BOTS`. Rather than duplicate its findings, the `pre` phase waits for it to finish and builds a
**skip-list** the model is told not to repeat.

Bots are matched by numeric GitHub App id (`review-orchestrator.mjs:69`) because logins and app slugs drift.
Polling uses jittered exponential backoff with two timeouts: a bot that never appears within ~60s is
treated as disabled and dropped from the wait-set, and the whole wait gives up after ~5 minutes
(`DISCOVERY_TIMEOUT_MS` / `COMPLETION_TIMEOUT_MS`, `:115-116`).

The skip-list excludes _specific already-reported findings_, never whole categories — the prompt says so
explicitly, because the categories generic bug-bots do not cover (architecture, conventions, testability,
docs-intent, readability) are the point of this reviewer. Our own comments are deliberately excluded from the
skip-list (`isBotComment`, `review-orchestrator.mjs:432-436`): feeding them back would nudge the model to suppress
its own prior findings.

## Deep mode and bounded mode

Spend is decided by code, not by the model (`computeDeepMode`, `review-orchestrator.mjs:519`):

| Flag          | Trigger                                                                | Effect                                                             |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `deepMode`    | ≥ 600 changed lines, or ≥ 40 files, or a `review:deep` label on the PR | The skill adds six narrow micro-specialists on top of its 11 lanes |
| `boundedMode` | The PR exceeds GitHub's 3000-file listing cap                          | The diff handed to the model is clipped to the first 200 files     |

Thresholds are `DEEP_MODE_CHANGED_LINES` and `DEEP_MODE_FILE_COUNT` (`:97-98`); the clip is
`BOUNDED_MODE_FILE_LIMIT` (`:105`). Bounded mode clips the actual input rather than only asking the model to stay
in scope, so the limit is enforced rather than advisory. Adding the `review:deep` label is the supported way to ask
for the expensive review on a PR that is small but risky.

## Convergence across pushes

The bot has to run on every push without turning the PR into a wall of repeated comments. It converges structurally
rather than by keeping state:

- Each finding carries a hidden stable hash (`findingHash`, `review-orchestrator.mjs:593`) keyed on the file, the
  rule id, and a **liveness key** — for an inline finding, a distinctiveness-checked window of diff text around the
  offending line: the trimmed line alone when that is distinctive, widened to its neighbours when it is not, so a
  bare `}` or `return;` cannot match every diff (`livenessWindowFor`, `:804`; `classifyFindings`, `:905`). A
  file-level finding keys on the path instead. Severity is deliberately _not_ hashed, because the gate is allowed to
  demote it and a re-keyed finding would post a duplicate.
- A finding whose hash already has an open thread is not posted again (`selectFindingsToPost`, `:1392`).
- A thread is auto-resolved only when its liveness key no longer appears in the diff (`shouldResolveThread`,
  `:1163`). "The model did not re-flag it this run" is a recall signal, not evidence of a fix, so it never resolves
  a thread on silence alone.
- A thread **a human resolved** is never re-posted (`:1491`), even though the code is unchanged — otherwise the bot
  would fight your resolve on every push. Threads the bot resolved itself are excluded from that suppression, so a
  genuine regression does reappear.
- On a clean PR it posts one affirmative "no issues" note and then stays quiet, suppressed when a prior thread is
  still open, when the latest own review is already that note, or on `reopened` (`decideTerminalAction`, `:1411`).

Inline comments are capped at 50 per review (`MAX_INLINE_COMMENTS`, `:110`); the overflow, plus any finding whose
file is not in the diff, rolls into an "Additional notes" section in the review body.

## What the reviewer is checking

Findings are rendered as `🚫 Blocking`, `📐 Convention`, or `🔧 Nit` (`SEVERITY_LABEL`, `:1195`).

Internally each finding carries a rule or invariant id — the skill's verification bar expects a real one, though the
JSON schema tolerates `null` — plus an `evidence` field quoting the offending line verbatim. The gate drops any
candidate whose evidence it cannot find in the diff. **Those ids are never rendered into the comment you
read** — they are meaningless in a PR thread — so if you want to know which rule a comment rests on, the
vocabulary lives in the skill's reference files:

| File                                    | Vocabulary                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `references/house-rules.md`             | `R-*` — TypeScript, React, data and i18n house rules, transcribed from `AGENTS.md` |
| `references/testing-rules.md`           | `R-*` — the test standard (`R-NOMOCKSHARED`, `R-DITEST`, `R-FAKETIMERS`, …)        |
| `references/architecture-invariants.md` | `INV-01`..`INV-80` — cross-subsystem invariants (tenancy, auth, E2EE, sync, …)     |
| `references/review-heuristics.md`       | The trigger table, IF–THEN rules and the deep correctness checklist                |
| `references/severity-rubric.md`         | Severity ⊥ confidence, and the register each tier is written in                    |
| `references/style-exemplars.md`         | How human-facing finding text should read                                          |

All of them live under `.claude/skills/thunder-deep-review/`. The `R-*` files are a _restatement with ids_ of docs
that remain the source of truth — [`AGENTS.md`](../../AGENTS.md) (symlinked as `CLAUDE.md`) for `house-rules.md`,
and [`docs/development/testing.md`](../development/testing.md) plus
[`backend/docs/testing.md`](../../backend/docs/testing.md) for `testing-rules.md`. Each file says so in its own
header: if a rule and its `R-*` entry disagree, the source doc wins and the reference file needs updating.

### Domain subagents

Two narrow, high-stakes domains ship their own read-only reviewer subagents, dispatched in addition to the skill's
category lanes when the diff touches their area:

- [`.claude/agents/powersync-sync-reviewer.md`](../../.claude/agents/powersync-sync-reviewer.md) — fires on
  `shared/powersync-tables.ts`, sync-rule `config.yaml`, Drizzle schema, `backend/drizzle/**` migrations,
  `src/db/powersync/**`, or a synced-table DAL/defaults/reconciliation. It checks the two-PR deploy flow,
  `_journal.json` integrity, sync-rule/column parity, sync classification across sibling tables, encryption config
  and hard-delete correctness. These are the mistakes that pass local testing and fail _silently_ across devices —
  see [powersync-account-devices.md](../architecture/powersync-account-devices.md).
- [`.claude/agents/react-effect-reviewer.md`](../../.claude/agents/react-effect-reviewer.md) — fires on React
  diffs for the full `useEffect`-discipline catalogue in `AGENTS.md`.

## Running it locally

The skill is committed to the repo, so Claude Code discovers it in this working tree — invoke
`/thunder-deep-review` (or ask for a deep review of a branch or PR number) before you push.

Local runs behave differently from CI on purpose. The skill detects its mode from the invoking prompt and, in local
mode, knows there is **no precision gate behind it**: the rendered markdown report (per
`assets/finding-template.md`) is the final artifact, so it applies its own filtering — the precision pass, recall
floors, a nit cap, and a self-validation gate. In CI it skips all of that and hands everything grounded to the
gate. Deep mode locally is opt-in: ask for it, or exceed the same ~600-line / ~40-file threshold CI uses.

For a lighter, fix-capable pass over your own branch before review, `/thunderimprove`
([`.thunderbot/thunderimprove.md`](../../.thunderbot/thunderimprove.md)) is the other surface — it is allowed to
edit; `thunder-deep-review` never is.

## Things that will bite

- **A new skill directory needs a `.gitignore` exception.** `.gitignore:50-59` ignores `.claude/**` and then
  un-ignores `commands/**`, `agents/**`, `rules/**` wholesale but only `skills/thunder-deep-review/**` under
  `skills/`. A new agent file is committable as-is; a second skill is invisible to CI until you add its carve-out.
- **Dangling `.claude` symlinks crash the run.** `.claude/commands/thunderbot` is a committed symlink to a path
  that does not exist, and the Agent SDK scans `.claude/` and dies with `ENOENT ... statx` on a broken link. The
  workflow prunes broken symlinks before each model step — and prunes them **twice**, because the first
  `claude-code-action` run restores them via its own internal checkout.
- **Action inputs are version-pinned and verified.** `model:`, `allowed_tools:` and `review_event:` do **not**
  exist on `claude-code-action@v1`; the model and tool allow-list go through `claude_args`. Both action SHAs are
  pinned. The model id is pinned literally in the workflow rather than sourced from `vars.*`, so review behaviour
  cannot change without a PR.
- **`Skill`, `Task` and `Agent` must stay on the allow-list.** They are permission-required tools and the action
  runs headless with no prompt, so a missing entry is silently denied — which would collapse the whole sub-reviewer
  fan-out to a single shallow pass with no error. Both `Task` and `Agent` are listed because the subagent-spawn
  tool is named differently across SDK versions.
- **The prompts treat the diff as data, never instructions.** PR titles, descriptions, code comments and the
  candidate findings themselves are untrusted content, and any text in them that tries to suppress findings or
  change the output contract is ignored — operating rule 6 of the skill covers the recall pass, and the gate's own
  prompt repeats it for the candidates file. The skill requires that rule in every sub-reviewer prompt it spawns;
  keep it in any new one.
- **The workflow recommends CODEOWNERS protection** for itself and `review-orchestrator.mjs` (they hold the review
  logic and the API-key reference). The repo has no CODEOWNERS file today, so that is still a to-do rather than a
  guarantee.
- **The only secret involved is the `ANTHROPIC_API_KEY` repo secret.** The workflow token is passed to the action
  so it authenticates with it instead of minting an App token over OIDC, which keeps `id-token: write` off the
  permission list.

## Where the code lives

| Path                                             | Role                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `.github/workflows/thunder-deep-review.yml`      | Triggers, gates, the two model steps, file handoff          |
| `.github/scripts/review-orchestrator.mjs`        | All GitHub I/O: poll, skip-list, diff, dedup, resolve, post |
| `.github/scripts/review-orchestrator.test.mjs`   | Unit tests for the pure orchestration logic                 |
| `.claude/skills/thunder-deep-review/SKILL.md`    | The reviewer itself: lanes, fan-out, both output contracts  |
| `.claude/skills/thunder-deep-review/references/` | `R-*` house rules, `INV-*` invariants, heuristics, severity |
| `.claude/agents/powersync-sync-reviewer.md`      | Synced-table domain reviewer                                |
| `.claude/agents/react-effect-reviewer.md`        | React `useEffect` domain reviewer                           |
