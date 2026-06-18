# Plan — Advisory AI PR Review on CI (A→B aggregation)

> **Status:** DRAFT, not wired. Corrected after a 3-model adversarial review
> (see `DEBATE-CONSOLIDATED.md`). The deterministic orchestration described
> below lives in **`scripts/review-orchestrator.mjs`** — all GitHub I/O happens
> in that code, not in the model's tool-calls.

## 0. Goal & non-goals
**Goal:** add an advisory AI review layer to PRs on `thunderbird/thunderbolt` that *complements* the existing bots with **best-effort (semantic) dedup**, updates cleanly on every push, and never gates merge.
**Non-goals (explicitly OUT):** NO auto-merge, NO auto-approval, NO merge queue, NO change to branch protection / human approval. Merge + approval stay 100% human. The bot only posts review comments.

> **Design change (reverses debate item A5):** B now posts an **inline PR review — comments anchored to each file's lines, like Cursor Bugbot** — not a single consolidated issue comment. This was chosen at the user's request to match the Bugbot inline UX over the single-comment simplicity A5 originally preferred; the trade-off is a **thread-based lifecycle** (resolve our own threads on fix) that is heavier than one editable comment, since review-comment bodies can't be PATCHed.

## 1. The two-job model
- **Job A — external SaaS bot (Cursor Bugbot)** (+ GitHub Advanced Security SAST). Run on their own infra reacting to the PR; they post their own native comments / check-runs. We do NOT orchestrate their execution (can't — they aren't workflow jobs). *(CodeRabbit is intentionally out of scope for now — easy to add back later by registering its `app.id`.)*
- **Job B — our `thunder-deep-review`.** Runs in our CI, AFTER A, and reports ONLY what A did not already catch (the architecture / convention / docs-intent / readability layer). Maps to the empirical low-overlap finding (146-PR study).
- **Result:** 2 clean comment sources (A native + **B's inline PR review — comments per line**), with **best-effort dedup** (semantic — imperfect by design; see §3). NOT one literal post (absorbing A's comments was rejected as brittle).

## 2. "B after A" without a `needs:` dependency (the key mechanism)
A is not a workflow job, so `needs:` cannot reference it. Instead a **deterministic poller** (in `scripts/review-orchestrator.mjs`, NOT the model) enumerates the GitHub check-runs for the **PR head SHA** once, identifies A's bots by **numeric `app.id`** (from an explicit expected-bots config — login/slug strings drift), and polls each existing run BY ID until `status === 'completed'` (accepting ANY conclusion).
- This gives "if A errors, B runs anyway" for free: B proceeds on ANY terminal conclusion (success, failure, cancelled, timed_out) or a timeout.
- **Discovery sub-timeout (~60s):** a bot whose run never appears is treated as *disabled on this PR* (dropped from the wait-set) — distinct from the full ~5-min completion timeout for a run that *exists* but hasn't finished.
- **Backoff:** jittered exponential (~15s→60s cap), honoring `Retry-After` and rate-limit headers; bail on 4xx, retry on 5xx; paginate every list (`per_page=100` + `Link`).
- Reconcile to `pull_request.head.sha`, never the synthetic merge ref.

### Orchestration is deterministic CODE, not model tool-calls
Per the review, the workflow does **not** let the model do GitHub I/O. The flow is:
1. **Pre-step** (`review-orchestrator.mjs pre`): poll A's bots → build the skip-list → compute the deterministic deep-mode flag → write them to files.
2. **Diff step**: a plain `git diff base..head` writes the diff to a bounded file (no model, no `Bash` tool).
3. **Model step**: reads the diff + skip-list files, emits **structured JSON findings only** to a file. No GitHub I/O, no `Bash`, read-only tools.
4. **Post-step** (`review-orchestrator.mjs post`): validate the JSON → map each finding to a diff position (`line` + `side`) → dedup against our own OPEN review threads → resolve our own FIXED threads → post ONE **inline PR review** (`event=COMMENT`) carrying the NEW findings as inline comments.

## 3. "Ignore what A already detected" (best-effort dedup / skip-list)
Before the model reviews, the **pre-step** fetches A's findings via the API and builds a skip-list:
- PR review (inline) comments authored by the bots — **authoritative**; check-run `output` summaries — **best-effort** (free text).
- Dedup key is normalized on `file + diff_hunk + side/original_line` (NOT raw line numbers — lines drift on force-push).
- The skip-list is handed to the model with a "defer to the other bots" directive: surface only what they missed (architecture, conventions, docs-intent, readability).
- If A produced nothing → empty skip-list → B reviews everything.
- **This is best-effort semantic dedup, not "zero overlap."** B may occasionally re-phrase an issue A already raised; that is accepted, not claimed away.

## 4. Job B internals (the reviewer)
- The model runs via `anthropics/claude-code-action` with **Bedrock + OIDC** (Zero-Data-Retention; code + model traffic stay on Mozilla-controlled infra). **No static AWS keys** — an OIDC-assumed role scoped to `bedrock:InvokeModel` on specific model ARNs.
- Model pinned to an Opus-tier id **literally in the workflow** (not `vars.*`). Read-only tools only (`Read, Grep, Glob`) — **no `Bash`**; the diff is pre-computed and handed in via a file.
- Invokes the `thunder-deep-review` skill: default = single fan-out; **deep mode** only for large/sensitive diffs, triggered by a **deterministic diff-size gate** (or a `review:deep` label) computed in code — never an LLM spend decision.
- Per the skill, **dispatches the `powersync-sync-reviewer` subagent** when the diff touches synced tables.
- Output: **structured JSON findings only** (severity ∈ {blocking, convention, nit}). The orchestrator validates severities against an enum, caps body length, and renders markdown deterministically. No raw-markdown trust; no model-emitted severity trailer.

## 5. The inline review lifecycle (Bugbot-style, thread-based)
> **This reverses debate item A5 at the user's request:** we chose the inline UX (comments anchored to each file's lines, like Bugbot) over the single-editable-comment simplicity A5 originally preferred. The lifecycle is therefore **thread-based** — we manage (and resolve) our OWN review threads — which is heavier than one PATCHable comment, but matches how Bugbot works.
- B posts ONE **PR review** (`POST /repos/{o}/{r}/pulls/{n}/reviews`) with `event=COMMENT` (never approve/request-changes → never gates), `commit_id = head SHA`, and `comments: [{path, line, side, body}, …]` — each finding anchored to its exact `file:line`. Each comment body carries **severity + fix + cited rule id**, plus a hidden `<!-- thunder-finding-hash:… -->` stamp.
- **Diff-position mapping:** the orchestrator parses the pre-computed diff to learn which `(side, line)` positions are commentable. A finding whose line **is** in the diff → real inline comment (`line` + `side`). A finding whose line is **not** in the diff but whose file is → **file-level comment** (`subject_type=file`). A finding whose file isn't in the diff at all → rolled into the review **body** summary. It **never crashes** on an un-anchorable finding.
- **Dedup vs our own open threads:** before posting, the orchestrator fetches OUR OWN existing review threads via **GraphQL** (`reviewThreads` → `id`, `isResolved`, root-comment author + stamped hash). A stable **finding-hash** (file + normalized diff-context anchor + rule + severity, NOT raw line numbers — they drift on force-push) matches a finding across pushes. We post **only findings NOT already present as an OPEN own-thread**; nits are grouped/capped so the review doesn't flood.
- **Resolve-on-fix (convergence):** on each new push we re-review the new head; for OUR OWN open threads whose finding **disappeared** from the current set (code fixed/changed), we call GraphQL **`resolveReviewThread`**. Scope is strictly **B's OWN threads** — we never touch Bugbot's or a human's. (Bugbot resolves its own.)
- On `reopened`, **thread resolution is suppressed** (the prior threads may be from another base/weeks ago).
- **Sticky-comment ownership:** the post-step owns the review; do NOT also enable the action's sticky comment (single owner — see README verify item 1).

## 6. Triggers
- `pull_request: [opened, synchronize, reopened, ready_for_review]` → re-runs on every push (`synchronize`); un-drafting triggers a first review.
- `concurrency` group per PR with `cancel-in-progress: true` → only the latest push is reviewed; a first **debounce `sleep 60`** step means rapid pushes cancel at zero model cost.

## 7. Security
- **Fork PRs are GATED OFF** at the job level: `if: github.event.pull_request.head.repo.full_name == github.repository` (plus skip Dependabot, skip drafts). A self-hosted runner must NEVER execute untrusted fork code. Do NOT use `pull_request_target` + checkout of fork head (key-exposure pwn-request). Fork coverage, if ever wanted, is a separate `workflow_run` metadata-only job that never executes fork code.
- **Prefer an ephemeral runner** (GitHub-hosted, or JIT/clean-VM self-hosted with no Docker socket, no cloud-metadata access, strict egress) over a persistent foothold.
- **OIDC, not static keys:** `id-token: write` + `aws-actions/configure-aws-credentials`, role scoped to `bedrock:InvokeModel` on specific model ARNs. Cloud creds are configured immediately before the model step and are absent during the untrusted-metadata pre-step.
- **No `Bash` tool** in the model step (closes the indirect-prompt-injection → token-exfil path over attacker-controlled diff content). The diff is pre-computed deterministically.
- Least-privilege scopes: `contents: read`, `pull-requests: write`, `checks: read` (poll), `id-token: write` (OIDC). NO merge/approve/contents-write scope.
- `actions/checkout` with `persist-credentials: false`; targeted base/head fetch, not `fetch-depth: 0`.
- All third-party actions pinned to full commit SHAs.
- The workflow file + `scripts/review-orchestrator.mjs` must be **CODEOWNERS-protected** (they hold cloud-cred config + the runner label). See `CODEOWNERS-note.md`.

## 8. Edge cases
- A never finishes within timeout → B proceeds, skip-list = whatever A posted so far (may re-flag a couple — acceptable, best-effort).
- B errors → orchestrator exits 0 (fail-soft), no review posted that run; next push retries.
- Huge diff → deterministic deep-mode/bounded-mode gate; the 3000-file PR-files cap and 1000-check-suite cap are detected and handled.
- Force-push / rebase → `synchronize` fires; B recomputes against new head SHA; dedup key resists line drift.
- Multiple rapid pushes → concurrency cancels stale runs during the debounce sleep (free).
- **Merge conflicts:** `pull_request` does NOT fire while a PR has conflicts — the review silently pauses during risky rebases. Documented; a metadata-only `pull_request_target` companion is possible later but never checks out fork code.

## 9. Resolved debate questions (was: open questions)
- **"A is done" signal:** poll check-runs by `app.id`, by run ID, to `status==completed` (source of truth). Events (`check_suite`/`check_run`) may later be used only as a cheaper wake-up, never as the done-signal.
- **Comment-in-place vs inline threads:** **inline PR review** with `event=COMMENT`, comments anchored per `file:line` (Bugbot-style). Review-comment bodies can't be PATCHed, so convergence is **thread-based**: dedup vs our own OPEN threads, `resolveReviewThread` on our own FIXED threads. _(This reverses debate item A5 — see §5 — at the user's request, trading single-comment simplicity for the inline UX.)_
- **Dedup reliability:** best-effort semantic; mitigated by an inline-comment-authoritative skip-list keyed on `diff_hunk`. Not claimed to be perfect.
- **Runner cost/latency:** debounce + deterministic deep-mode gate + concurrency cancellation bound spend.

## 10. Rollout (later, only with explicit approval)
Resolve every `<PLACEHOLDER>` / `# TODO:` (action SHAs, OIDC role + model ARNs, model id, runner strategy, real bot `app.id`s) → **verify all claude-code-action @v1 input names against current docs** → check in `scripts/review-orchestrator.mjs` (CODEOWNERS-protected) → move `thunder-deep-review.yml` to `.github/workflows/` → test PR → confirm comment-only, no gating. Nothing here is wired/committed.
