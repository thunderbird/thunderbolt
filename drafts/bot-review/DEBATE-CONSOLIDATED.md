# Consolidated Adversarial Review — Advisory AI PR-Review CI Plan

**Critics consulted (all 3 responded):**
- **GLM-5.2** (pal__chat, temp 0.3, thinking=high) — 17 findings.
- **Xiaomi MiMo** (`mimo-v2.5-pro`, temp 0.3, thinking=high) — 24 findings.
- **Codex / gpt-5.5** (local CLI, sandbox=read-only, reasoning=xhigh) — 30 findings, doc-cited against live GitHub docs. *(pal `clink` wrapper failed — `codex` not on its PATH — so ran via the absolute-path binary.)*

Raw critiques: `DEBATE-RAW.md`. Convergence was high: all three independently flagged the missing permission, the fork/self-hosted execution risk, pagination gaps, the comment-vs-review lifecycle bug, and cost/timeout gaps. Codex additionally caught that **the action's input names are flat-out wrong for `@v1`** and that the **YAML implements none of the plan's orchestration** — neither of which the other two surfaced, and both are blocking.

---

## A. Must-fix gaps
*(≥2 models, or a single critical safety/correctness hole.)*

### A1. `checks: read` is missing — the polling mechanism 403s on the first call. **[ALL THREE]**
The entire "B after A" sequencing (§2) needs the Checks API, but the YAML grants only `contents: read` + `pull-requests: write`. Because `permissions:` is declared, every unlisted scope defaults to `none`, so the very first check-runs request returns 403 and B runs blind/concurrent with A — collapsing the "zero duplication" premise.
**Fix:** add `checks: read` to `permissions:`.

### A2. The workflow implements *none* of the plan's orchestration. **[Codex; implied by GLM/MiMo's "compound failure"]**
The YAML just runs `claude-code-action` once. There is no poller, no skip-list fetch, no marker lookup, no edit-in-place, no resolved-state diff. The plan describes a deterministic control loop the workflow doesn't contain.
**Fix:** the plan must specify explicit deterministic pre-steps (poll → fetch+paginate A's findings → build skip-list → read prior marker JSON) and a post-step (render → upsert the single comment via Octokit). The model produces *structured findings only*; all GitHub I/O happens in code, not in the model's tool calls. (This reframes A3, A6, A8, A9 below as "the surrounding code does it," not "the model does it.")

### A3. The `claude-code-action@v1` inputs are wrong/deprecated. **[Codex — unique, blocking]**
`model` and `allowed_tools` are deprecated in `@v1`; `review_event` is **not an action input at all**. Bedrock is configured via `use_bedrock: "true"` + OIDC, not static AWS env vars. As written the step won't behave as intended (and `review_event: COMMENT` silently does nothing).
**Fix:** use `claude_args: --model … --allowedTools …`, `use_bedrock: "true"`, and (for the sticky comment) `use_sticky_comment: "true"`. Re-verify all input names against current action docs before wiring — the README already flags this, but the draft YAML ignored its own warning.

### A4. Fork/untrusted PRs are NOT blocked, and a self-hosted runner makes that dangerous. **[ALL THREE]**
"Fork PRs get no secrets → B doesn't run on forks" is false: the job still *schedules and executes* on the self-hosted runner with the fork's checked-out code (`fetch-depth: 0` pulls everything). GitHub explicitly warns self-hosted runners can be **persistently** compromised by untrusted PR code. Even internal PRs get `AWS_*` in-env, and `Bash(...)` over attacker-controlled diff content is an indirect-prompt-injection → token-exfil path.
**Fix (layered):**
- Gate the job: `if: github.event.pull_request.head.repo.full_name == github.repository` (also handle/skip Dependabot).
- Move off long-lived AWS keys to **OIDC** (`id-token: write` + `aws-actions/configure-aws-credentials`, role scoped to `bedrock:InvokeModel` on specific model ARNs).
- Prefer an **ephemeral** runner (GitHub-hosted or JIT self-hosted, clean VM per job, no Docker socket, no cloud-metadata access, strict egress) over a persistent foothold.
- `actions/checkout` with `persist-credentials: false`.
- Keep cloud secrets out of the model step entirely (render comments in a separate Octokit step; see A2).

### A5. The comment lifecycle conflates *issue comments* with *reviews* — and review bodies can't be edited. **[GLM, MiMo, Codex]**
§5's "find-by-marker → edit in place" only works on **issue comments** (`POST .../issues/{n}/comments` + `PATCH .../issues/comments/{id}`). A `review` (`event=COMMENT`) is a different object with **no PATCH on its body** — "edit in place" would force delete+recreate, destroying reply threads. And `review_event` isn't even a real input (A3).
**Fix:** commit to **issue comments** for the consolidated post (or the action's `use_sticky_comment`). Drop the "or a review with event=COMMENT" ambiguity from the plan.

### A6. Pagination is absent — skip-list and marker lookup silently truncate on exactly the noisy PRs where they matter. **[ALL THREE]**
PR review comments, issue comments, PR files, and check-runs all default to 30/page (max 100). Without pagination: (a) CodeRabbit's 50+ comments truncate → incomplete skip-list → B duplicates A; (b) the marker comment, if older than page 1, isn't found → B posts a **duplicate** consolidated comment. Codex adds two hard cliffs: the **1000-check-suite** cap on `/commits/{sha}/check-runs` and the **3000-file** cap on PR files.
**Fix:** paginate every endpoint (`per_page=100` + follow `Link`, or Octokit paginate). For noisy refs, enumerate check *suites* then runs by `check_suite_id`. Detect file-count truncation early and switch to a bounded review mode.

### A7. The poller has real race + consistency bugs, and "terminal state" is the wrong concept. **[GLM, MiMo, Codex]**
- **Status vs conclusion (Codex):** check runs have `status: completed`; `failure`/`cancelled`/`timed_out` are *conclusions*. Wait for `status == completed`, accept any conclusion.
- **Creation race (GLM):** a poll before a slow bot's run exists can't distinguish "not started" from "disabled"; the 5-min timeout then yields an empty skip-list for a merely-slow bot → B duplicates A.
- **Eventual consistency (GLM, MiMo):** a just-`completed` run can lag in the list response, and even when the check is `completed`, its review comments (separate write path) may not be visible via REST yet.
- **Identity fragility (GLM, MiMo, Codex):** matching on `cursor[bot]`/`coderabbitai[bot]` login strings or `app.slug` is brittle (logins/slugs change; apps create multiple runs; endpoint defaults to `filter=latest`).
**Fix:** enumerate once, poll each run by ID until `status==completed`; identify bots by numeric `app.id` with an explicit **expected-bots config**; use a short discovery sub-timeout (~60s) for "never appeared = treat as disabled" vs the full 5-min only for runs that exist but aren't complete; after terminal, re-fetch comments with a short stabilization delay/retry; `filter=all`, `per_page=100`, paginate.

### A8. Rate limits / secondary-abuse limits / no backoff. **[GLM, MiMo, Codex]**
`GITHUB_TOKEN` = 1000 REST req/hr/repo; 15s polling across many open PRs plus comment create/edit churn can trip **secondary** limits (GitHub explicitly calls out fast comment creation). Fixed-interval polling with no backoff compounds it under 5xx.
**Fix:** jittered exponential backoff (≈15s→60s cap), honor `Retry-After`/rate-limit headers, conditional requests, distinguish 4xx (bail) from 5xx (retry); only edit the comment when content actually changed; never post "no-findings" churn as a *new* comment.

### A9. "Resolved since last push" relies on the model parsing its own prior markdown — and breaks under cancellation. **[GLM, MiMo, Codex]**
The diff of previous-vs-current findings is unreliable if the model rephrases/reorders, and `cancel-in-progress: true` can kill a run mid-edit (TOCTOU between two concurrent runs reading the same comment; partial/lost prior state).
**Fix:** store prior findings as a **hidden JSON block** inside the comment, keyed by stable finding-hashes + reviewed head SHA; compute the resolved-diff structurally in code; update the comment only after a successful render via a single atomic `PATCH`, using `updated_at`/`node_id` as an optimistic lock. On `reopened`, skip/relabel the Resolved section (last push may be weeks/another base ago) — **[GLM]**.

### A10. No `timeout-minutes` — "cap runner time" is unimplemented. **[GLM, MiMo, Codex]**
A hung model call or Bedrock outage holds the runner indefinitely.
**Fix:** `timeout-minutes` on job and step, plus Claude `--max-turns`.

### A11. Supply-chain: mutable action tags. **[MiMo, Codex]**
`actions/checkout@v4` and `claude-code-action@v1` are floating; a compromised upstream runs on your runner with cloud creds in-env.
**Fix:** pin every third-party action to a full commit SHA; Renovate/Dependabot to bump.

### A12. Cost trap: Opus-tier + deep mode on every push, cancellations don't refund. **[GLM, MiMo, Codex]**
Rapid pushes (rebases, typo fixes) burn model budget on runs cancelled mid-flight; the "deep mode cost gate" is delegated to the LLM ("use the skill") with no deterministic trigger.
**Fix:** debounce at job start (`sleep ~60` — cancellation during sleep costs nothing); compute diff size in a deterministic pre-step and set the deep-mode flag in code (optionally also a `review:deep` label); don't let the model self-regulate spend.

---

## B. Worth-considering improvements
*(good, non-required.)*

- **B1. Define the zero-findings case [MiMo].** Always post "✅ No additional findings" so absence-of-comment isn't ambiguous (failed vs not-run vs clean).
- **B2. Head-SHA vs merge-ref correctness [Codex].** On `pull_request`, `GITHUB_SHA` is the synthetic merge commit; poll *and* check out `github.event.pull_request.head.sha` so B reviews the same code A's checks describe.
- **B3. Merge-conflict gap [Codex].** `pull_request` doesn't fire when a PR has conflicts — review silently disappears during risky rebases. Document, or add a metadata-only `pull_request_target` companion (never checks out fork code).
- **B4. Drop or validate the severity trailer [GLM, MiMo, Codex].** "BLOCKING" anchors humans, so the trailer is a *soft* gate even if nothing technically gates on it; a model-emitted mislabel misleads reviewers, and markdown-normalizing tools destroy the HTML-comment form. Either remove it or emit/validate structured JSON against an enum.
- **B5. Pin the model id, don't use `vars.*` [MiMo].** A mutable org/repo variable lets someone change review behavior for every PR with no PR/audit trail. Hardcode or assert an expected value.
- **B6. Better dedup key [Codex].** `{file,line,body}` is junk — lines drift on force-push. Normalize against `diff_hunk` and include `side`/`start_line`/`original_line`/`commit_id`.
- **B7. CODEOWNERS guard on the workflow file [MiMo].** Restrict who can edit a YAML that holds cloud creds + a self-hosted runner label.
- **B8. Pass `GH_TOKEN` explicitly if any `gh` call is kept [MiMo].** `gh pr diff` 401s without it; don't rely on undocumented action behavior. (Moot if you pre-compute the diff per A2/B9.)
- **B9. `fetch-depth: 0` is wasteful [GLM, MiMo, Codex].** Fetch only base/head SHAs, or generate the diff outside the model and hand it in as a bounded artifact.
- **B10. Self-hosted runner cleanup [MiMo].** Persistent runners accumulate temp files / env between jobs; use a `container:` job or post-job cleanup (subsumed by the ephemeral-runner recommendation in A4).
- **B11. Trigger coverage [Codex, MiMo].** Consider `ready_for_review`, skip drafts (`if: …draft == false`); decide consciously about `edited`.
- **B12. Validate `AWS_REGION` early [MiMo].** Unset → opaque "Unable to resolve region"; Opus availability varies by region. (Largely moot once OIDC is in.)

---

## C. Disagreements / trade-offs (+ adjudication)

- **C1. Event-driven vs polling.** GLM: `check_suite: completed` is the *wrong* signal (per-app-per-suite, no "all suites done" event) — keep polling. Codex: prefer `check_suite`/`check_run` events to dodge rate limits. **Adjudication:** they're reconciled by an event-*plus*-state design — trigger/wake on `check_suite`/`check_run` to avoid tight 15s polling, but still reconcile actual completion by querying run state by ID (you can't assume one event means "all bots done"). Net: reduce polling frequency via events; don't treat any single event as the done-signal. Polling stays the source of truth; events are just a cheaper wake-up.
- **C2. How hard to chase fork coverage.** Plan defers forks to a future `workflow_run`; Codex suggests a `pull_request_target` metadata-only companion for the conflict/fork gap. **Adjudication:** for an advisory, internal-PR-first bot, **defer fork coverage** (matches the plan and is the safer default). If pursued later, the metadata-only-no-fork-checkout constraint is non-negotiable.
- **C3. Keep vs drop the `Bash` tools.** GLM/Codex: drop `Bash(git diff/gh pr diff)` and pre-compute the diff in a controlled step. **Adjudication:** drop them — it both closes the injection surface (A4) and removes the `GH_TOKEN` dependency (B8). The diff is cheap to compute deterministically and hand to the model via `Read`.

No hard contradictions otherwise — the three are overwhelmingly additive.

---

## D. Validated-as-sound (don't churn these)

- **Polling as the core mechanism** to sequence "B after A" — correct given the bots aren't workflow jobs; `needs:` genuinely can't reference them (GLM explicitly endorses; Codex/MiMo only refine it).
- **Advisory / comment-only posture** — `event=COMMENT`, never APPROVE/REQUEST_CHANGES, no auto-merge/approval, branch protection untouched. No critic challenged the no-gating stance; it's the right safety default.
- **Refusing `pull_request_target` + fork-head checkout** (the pwn-request) — all three agree this is the correct thing to avoid.
- **Fail-soft on B errors** (no comment that run; next push retries) — sound for an advisory tool.
- **"Two clean sources, not one literal merged post"** (not absorbing A's comments) — no critic argued for absorbing A; the rejection stands.
- **Treating semantic dedup as best-effort** — all three agree it can't be perfect; the fix is to *stop claiming* "zero overlap" (D/A note), not to redesign it.

---

## E. Concrete plan/workflow deltas (punch-list)

**Permissions / triggers / job shell**
1. Add `checks: read` (and `id-token: write` for OIDC) to `permissions:`. *(A1, A4)*
2. Add job gate `if: github.event.pull_request.head.repo.full_name == github.repository`; handle/skip Dependabot; consider `ready_for_review`/draft skip. *(A4, B11)*
3. Add `timeout-minutes` (job + step) and `--max-turns`. *(A10)*
4. Add a debounce `sleep ~60` first step. *(A12)*
5. `actions/checkout` → `persist-credentials: false`, and replace `fetch-depth: 0` with a targeted base/head fetch (or drop checkout and pass a pre-computed diff artifact). *(A4, B9)*
6. Pin `actions/checkout` and `claude-code-action` to full commit SHAs. *(A11)*

**Action invocation**
7. Replace `model:`/`allowed_tools:`/`review_event:` with `claude_args: --model … --allowedTools …`, `use_bedrock: "true"`, `use_sticky_comment: "true"`; re-verify against current action docs. *(A3)*
8. Drop `Bash(git diff:*)` / `Bash(gh pr diff:*)`; feed the diff via `Read` of a pre-computed file. *(A4, C3)*
9. Replace static `AWS_ACCESS_KEY_ID/SECRET` with OIDC (`aws-actions/configure-aws-credentials`, role scoped to `bedrock:InvokeModel` on specific ARNs). *(A4)*
10. Pin the model id (don't source it from `vars.*`); validate region (moot after OIDC). *(B5, B12)*

**Orchestration (must be added as deterministic steps, not model tool-calls)**
11. **Poller:** enumerate check-runs once → poll each by ID until `status==completed`; identify bots by `app.id` from an explicit expected-bots config; short discovery sub-timeout (~60s) for "never appeared" vs full ~5-min for "exists, not complete"; jittered exponential backoff + `Retry-After`; reconcile to head SHA. *(A2, A7, A8)*
12. **Skip-list fetch:** paginate review comments + check-run outputs (`per_page=100` + `Link`); for noisy refs, list check *suites* then runs by `check_suite_id`; treat inline comments as authoritative, summaries best-effort; normalize the dedup key against `diff_hunk`/`side`/`original_line`. *(A6, A7, B6)*
13. **Comment upsert:** issue-comment only; paginate to find the marker; embed a hidden JSON block (prior findings keyed by finding-hash + head SHA, plus `run_id`+`head_sha`); single atomic `PATCH` with optimistic lock; only mutate when content changed; on `reopened` skip the Resolved section; always post an explicit "no additional findings" state. *(A5, A6, A9, B1)*
14. **Output contract:** model emits **structured JSON findings only**; code validates severities against an enum, caps body length, renders markdown deterministically. Drop or validate-and-render the severity trailer rather than trusting raw model markdown. *(A2, B4)*

**Big-diff / coverage edges**
15. Detect the 3000-file / truncation edge and switch to a bounded review mode; make the deep-mode trigger a deterministic diff-size gate (+ optional `review:deep` label), not an LLM decision. *(A6, A12)*
16. Document the merge-conflict / head-vs-merge-ref behavior; check out and review the PR head SHA. *(B2, B3)*

**Plan-text honesty**
17. Replace "zero content duplication / zero overlap" with **"best-effort dedup"** throughout. *(A6, D, Codex #30)*
18. Add CODEOWNERS protection for the workflow file. *(B7)*

---

**Bottom line:** the *strategy* (advisory, comment-only, poll-then-dedup, never-gate, ZDR) is sound and was validated by all three critics. The *current draft* is not implementable as written — it has one hard blocker that 403s the mechanism (A1), an action invocation whose inputs don't exist in `@v1` (A3), a fork/self-hosted execution exposure (A4), a comment-lifecycle that targets an uneditable object (A5), and zero of the orchestration the plan describes (A2). Everything else is hardening. Fix A1–A5 before any wiring; treat A6–A12 as required-before-production.
