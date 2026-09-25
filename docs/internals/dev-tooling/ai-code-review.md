# AI Code Review (`thunder-deep-review`)

Every non-draft pull request from a branch in this repository (Dependabot excepted) gets an automated review from
`thunder-deep-review`: inline comments by `github-actions[bot]` under a review body headed
"🔭 thunder-deep-review (advisory)".

| Aspect        | Behaviour                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger       | `pull_request`: `opened, synchronize, reopened, ready_for_review` (`thunder-deep-review.yml:30`)                                            |
| Gated off     | fork PRs, Dependabot, drafts (`thunder-deep-review.yml:55`)                                                                                 |
| Posts         | one PR review with `event: 'COMMENT'`, max 50 inline comments                                                                               |
| Never does    | approve, request changes, or merge; it never gates anything                                                                                 |
| On error      | logs and exits 0 without posting (`review-orchestrator.mjs:158`); the next push retries                                                     |
| Cost guards   | 60s debounce `sleep` (`thunder-deep-review.yml:102`), `cancel-in-progress` keyed on the PR number (`:42-47`), `timeout-minutes: 30` (`:69`) |
| Permissions   | `contents: read`, `pull-requests: write`, `checks: read` (`thunder-deep-review.yml:37-40`)                                                  |
| Secret        | `ANTHROPIC_API_KEY` only                                                                                                                    |
| Run it myself | `/thunder-deep-review` in this working tree                                                                                                 |

## Can it block my merge? No

`event: 'COMMENT'` is the only event the orchestrator sends (`.github/scripts/review-orchestrator.mjs:1301`, `:1316`,
`:1361`), so a finding is feedback, not a CI failure; `/thunderfix`
([`.thunderbot/thunderfix.md`](../../../.thunderbot/thunderfix.md)) treats it that way. Reply in the thread if a finding
is wrong; a thread you resolve yourself stays resolved (see [Convergence](#convergence-across-pushes)).

Fail-soft on purpose: a missing review is acceptable, a broken or duplicated one is not.

## When it runs

The job `if:` hard-gates on three conditions:

- **Same-repo PRs only** (`head.repo.full_name == github.repository`): the job holds `ANTHROPIC_API_KEY`. Do not
  "fix" fork coverage with `pull_request_target` plus a fork-head checkout, the pwn-request key-exposure pattern
  (`:31-34`); it needs a separate metadata-only `workflow_run` job.
- **Not Dependabot.**
- **Not a draft**; `ready_for_review` is in the trigger list, so un-drafting starts a review.

Rapid pushes cancel each other during the 60-second debounce at zero model cost; `timeout-minutes: 30` guards a hung
model call. Without `checks: read` the bot poller 403s.

## Two model steps: recall, then a precision gate

| Step                    | Configuration                                           | Job                                                                     |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Recall (`:197`)         | `thunder-deep-review` skill, `--effort xhigh`, 40 turns | Over-generates _candidate_ findings, including unsure ones              |
| Precision gate (`:403`) | `--effort high`, 12 turns                               | Decides which candidates a senior engineer would leave in a real review |

The split fixes the "always finds something" failure mode of single-pass review bots: high recall alone buries real
bugs in noise, one precision-tuned pass misses things.

- The gate **defaults to drop**; `{"findings":[]}` is a successful review.
- It may **demote** severity (`blocking → convention → nit`), never raise it, and leaves every other field
  byte-for-byte verbatim.
- It is skipped when recall returns zero candidates; empty in can only yield empty out, so the call would be pure
  spend.
- Read-only tools only: `Read,Grep,Glob,Skill,Task,Agent` for recall (`:252`), `Read,Grep,Glob` for the gate
  (`:426`).
- Recall cannot write files, so it returns `structured_output` against a `--json-schema` and a shell step persists it
  to disk.
- That step **fails loudly** on an empty `structured_output`: a cancelled or errored model step must be a red check,
  not a fake "no issues". Clean is the non-empty string `{"findings":[]}`.

## Orchestration is deterministic code, not model tool-calls

The model does **no** GitHub I/O. All of it lives in `.github/scripts/review-orchestrator.mjs` (zero npm
dependencies, built-in `fetch`), in two phases around the model steps.

| Phase  | Step                                                                                | What it does                                                                                                     |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pre`  | [`thunder-deep-review.yml:154`](../../../.github/workflows/thunder-deep-review.yml) | Polls the external review bots, builds the skip-list, reconstructs the unified diff, computes the deep-mode flag |
| `post` | [`thunder-deep-review.yml:538`](../../../.github/workflows/thunder-deep-review.yml) | Validates the model JSON, anchors findings to diff lines, dedups, resolves fixed threads, posts one PR review    |

- **The diff is rebuilt from the Files API, not `git diff`.** `Accept: v3.diff` caps at 20,000 lines / 1 MB and 406s
  on large PRs, so the orchestrator paginates `/pulls/{n}/files` (`buildUnifiedDiff`, `review-orchestrator.mjs:878`).
  That endpoint returns the merge-base..head set `POST /pulls/{n}/reviews` anchors against; a two-dot `base..head`
  diff would use base's _current_ tip and 422 the review by injecting base-only commits as reverse diffs.
- Everything reconciles to the PR head SHA, never the synthetic merge ref, so the poller and the diff describe the
  same code.
- Unit-tested (`.github/scripts/review-orchestrator.test.mjs`) as part of `bun run test`.

## Sequencing behind the external bots

Cursor Bugbot is the one external reviewer registered in `EXPECTED_BOTS`; the `pre` phase waits for it and builds a
**skip-list** the model must not repeat.

- Bots are matched by numeric GitHub App id (`review-orchestrator.mjs:69`); logins and app slugs drift.
- Jittered exponential backoff with two timeouts: a bot absent after ~60s counts as disabled and is dropped, and the
  whole wait gives up at ~5 minutes (`DISCOVERY_TIMEOUT_MS` / `COMPLETION_TIMEOUT_MS`, `:115-116`).
- The list holds _specific already-reported findings_, never whole categories: architecture, conventions,
  testability, docs-intent and readability are this reviewer's point.
- Our own comments are excluded (`isBotComment`, `:432-436`), or the model would suppress its own prior findings.

## Deep mode and bounded mode

Spend is decided by code, not by the model (`computeDeepMode`, `review-orchestrator.mjs:519`).

| Flag          | Trigger                                                                | Effect                                                             |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `deepMode`    | ≥ 600 changed lines, or ≥ 40 files, or a `review:deep` label on the PR | The skill adds six narrow micro-specialists on top of its 11 lanes |
| `boundedMode` | The PR exceeds GitHub's 3000-file listing cap                          | The diff handed to the model is clipped to the first 200 files     |

Thresholds are `DEEP_MODE_CHANGED_LINES` and `DEEP_MODE_FILE_COUNT` (`:97-98`); the clip is `BOUNDED_MODE_FILE_LIMIT`
(`:105`), applied to the input itself so it is enforced rather than advisory. Label a small but risky PR
`review:deep` to buy the expensive review.

## Convergence across pushes

Convergence is structural, not stateful, so running on every push adds no repeats.

- Each finding carries a hidden stable hash (`findingHash`, `review-orchestrator.mjs:593`) over the file, the rule id,
  and a **liveness key**: a distinctiveness-checked window of diff text around the line, or the path for a file-level
  finding.
- The window is the trimmed line when distinctive, widened to its neighbours when not, so a bare `}` or `return;`
  cannot match every diff (`livenessWindowFor`, `:804`; `classifyFindings`, `:905`).
- Severity is deliberately _not_ hashed: the gate may demote it, and a re-keyed finding would duplicate the comment.
- A hash that already has an open thread is not posted again (`selectFindingsToPost`, `:1392`).
- Threads auto-resolve only when the liveness key leaves the diff (`shouldResolveThread`, `:1163`); model silence is a
  recall signal, not evidence of a fix.
- A thread **a human resolved** is never re-posted (`:1491`), even with the code unchanged. Bot-resolved threads are
  exempt, so a genuine regression reappears.
- A clean PR gets one "no issues" note, suppressed when a prior thread is open, when the latest own review is already
  that note, or on `reopened` (`decideTerminalAction`, `:1411`).
- 50 inline comments max (`MAX_INLINE_COMMENTS`, `:110`); overflow and findings whose file is not in the diff go to an
  "Additional notes" section in the review body.

## What the reviewer is checking

Findings render as `🚫 Blocking`, `📐 Convention`, or `🔧 Nit` (`SEVERITY_LABEL`, `:1195`). The rule vocabulary lives
under `.claude/skills/thunder-deep-review/`.

| File                                    | Vocabulary                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `references/house-rules.md`             | `R-*`: TypeScript, React, data and i18n house rules, transcribed from `AGENTS.md` |
| `references/testing-rules.md`           | `R-*`: the test standard (`R-NOMOCKSHARED`, `R-DITEST`, `R-FAKETIMERS`, …)        |
| `references/architecture-invariants.md` | `INV-01`..`INV-80`: cross-subsystem invariants (tenancy, auth, E2EE, sync, …)     |
| `references/review-heuristics.md`       | The trigger table, IF–THEN rules and the deep correctness checklist               |
| `references/severity-rubric.md`         | Severity ⊥ confidence, and the register each tier is written in                   |
| `references/style-exemplars.md`         | How human-facing finding text should read                                         |

- Each finding internally carries a rule or invariant id (the skill's verification bar expects a real one; the JSON
  schema tolerates `null`) plus `evidence` quoting the offending line verbatim. The gate drops candidates whose
  evidence is not in the diff.
- **Those ids are never rendered into the comment you read.** The table above is how you trace one back to its rule.
- The `R-*` files restate, with ids, docs that remain the source of truth: [`AGENTS.md`](../../../AGENTS.md) (symlinked
  as `CLAUDE.md`) for `house-rules.md`, [`docs/internals/development/testing.md`](../development/testing.md) plus
  [`backend/docs/testing.md`](../../../backend/docs/testing.md) for `testing-rules.md`. On disagreement the source doc
  wins and the reference file needs updating.

### Domain subagents

Two high-stakes domains ship read-only subagents, dispatched alongside the skill's category lanes when the diff
touches their area.

- [`.claude/agents/powersync-sync-reviewer.md`](../../../.claude/agents/powersync-sync-reviewer.md) fires on
  `shared/powersync-tables.ts`, sync-rule `config.yaml`, Drizzle schema, `backend/drizzle/**`, `src/db/powersync/**`,
  or a synced-table DAL/defaults/reconciliation, and checks the two-PR deploy flow, `_journal.json` integrity,
  sync-rule/column parity, sync classification across sibling tables, encryption config and hard-delete correctness.
  These mistakes pass local testing and fail _silently_ across devices (see
  [powersync-account-devices.md](../architecture/powersync-account-devices.md)).
- [`.claude/agents/react-effect-reviewer.md`](../../../.claude/agents/react-effect-reviewer.md) fires on React diffs for
  the `useEffect`-discipline catalogue in `AGENTS.md`.

## Running it locally

The skill is committed, so Claude Code discovers it here: invoke `/thunder-deep-review` (or ask for a deep review of a
branch or PR number) before you push. Deep mode locally is opt-in: ask for it, or exceed the same ~600-line /
~40-file threshold CI uses.

The skill reads its mode from the invoking prompt. Locally there is **no precision gate behind it**, so the markdown
report (per `assets/finding-template.md`) is the final artifact and the skill filters itself: precision pass, recall
floors, a nit cap, self-validation. In CI it skips that and hands everything grounded to the gate.

`/thunderimprove` ([`.thunderbot/thunderimprove.md`](../../../.thunderbot/thunderimprove.md)) is the lighter,
fix-capable pass and may edit; `thunder-deep-review` never does.

## Things that will bite

- **A new skill directory needs a `.gitignore` exception.** `.gitignore:50-59` ignores `.claude/**`, then un-ignores
  `commands/**`, `agents/**`, `rules/**` wholesale but only `skills/thunder-deep-review/**`. New agent files commit
  as-is; a second skill is invisible to CI without its own carve-out.
- **Dangling `.claude` symlinks crash the run.** `.claude/commands/thunderbot` points nowhere and the Agent SDK dies
  scanning `.claude/` with `ENOENT ... statx`. The workflow prunes broken symlinks before each model step, twice,
  because the first `claude-code-action` run restores them from its own internal checkout.
- **Action inputs are pinned and verified.** `model:`, `allowed_tools:` and `review_event:` do **not** exist on
  `claude-code-action@v1`; the model and tool allow-list go through `claude_args`. Both action SHAs are pinned, and
  the model id is pinned literally in the workflow rather than read from `vars.*`, so review behaviour cannot change
  without a PR.
- **`Skill`, `Task` and `Agent` must stay on the allow-list.** Permission-required tools are silently denied in a
  headless run, collapsing the sub-reviewer fan-out to one shallow pass with no error. Both `Task` and `Agent` are
  listed because the subagent-spawn tool is named differently across SDK versions.
- **The diff is data, never instructions.** PR titles, descriptions, code comments and candidate findings are
  untrusted; text trying to suppress findings or change the output contract is ignored (operating rule 6 for recall,
  repeated in the gate prompt). Keep that rule in any new sub-reviewer prompt.
- **The workflow recommends CODEOWNERS protection** for itself and `review-orchestrator.mjs`, which hold the review
  logic and the API-key reference. The repo has no CODEOWNERS file today, so it is a to-do, not a guarantee.
- **`ANTHROPIC_API_KEY` is the only secret.** The workflow token is passed to the action instead of minting an App
  token over OIDC, which keeps `id-token: write` off the permission list.

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
