# Bot review (advisory) — DRAFT, not wired

**Scope:** the thunder-deep-review bot posts its findings as an **inline PR review — comments on each file's lines, like Cursor Bugbot** — on every PR, complementing Cursor Bugbot (and GitHub Advanced Security). **Humans still approve and merge — nothing about the merge/approval flow changes.**

This supersedes `drafts/auto-merge/` (which automated approval+merge — decided against on security grounds). This draft was corrected after a 3-model adversarial review (`DEBATE-CONSOLIDATED.md`).

## Files in this draft
- `PLAN.md` — the corrected plan (the authoritative narrative).
- `thunder-deep-review.yml` — the workflow (DRAFT; placeholders throughout).
- `scripts/review-orchestrator.mjs` — **the deterministic orchestration** (zero-dep Node): poller, skip-list builder, comment upsert. All GitHub I/O lives here, NOT in the model's tool-calls.
- `DEBATE-CONSOLIDATED.md` / `DEBATE-RAW.md` — the review that drove these corrections.
- `CODEOWNERS-note.md` — why the workflow + script must be CODEOWNERS-protected.

## Corrected architecture (what changed after review)
- **Orchestration is deterministic code, not model tool-calls.** A pre-step polls A's bots and builds the skip-list; the model emits **structured JSON findings only**; a post-step validates, maps findings to diff positions, and posts the inline review.
- **Inline PR review — comments on each file's lines, like Bugbot** (`event=COMMENT`, anchored to the head SHA). Convergence is **thread-based**: dedup against our own OPEN review threads, and `resolveReviewThread` on our own threads once a finding is fixed. _(This reverses debate item A5 — which preferred a single editable issue comment — at the user's request, trading that simplicity for the Bugbot inline UX; review-comment bodies can't be PATCHed, so the lifecycle is necessarily thread-based.)_
- **Best-effort (semantic) dedup** — the earlier "zero overlap / zero duplication" claim was dropped as dishonest.
- **Poller** identifies A's bots by **numeric `app.id`** (not login/slug strings), polls each run to `status==completed` (any conclusion), with a short discovery sub-timeout, jittered backoff, `Retry-After`, and pagination.
- **Security hardening:** fork PRs gated off at the job level, Dependabot/drafts skipped, **OIDC instead of static AWS keys**, **no `Bash` tool** in the model step (diff pre-computed), `persist-credentials: false`, all actions pinned to SHAs, ephemeral runner preferred, `timeout-minutes` + debounce + deterministic deep-mode gate.

## What this is / isn't
- ✅ One advisory reviewer added to the lineup, posting an **inline PR review (comments on each file's lines, like Bugbot)** with `event=COMMENT` — **never** APPROVE/REQUEST_CHANGES, so it can never block or gate.
- ✅ Read-only model (`Read, Grep, Glob` only), Bedrock via OIDC (ZDR) — code/model traffic stays on your infra.
- ✅ Dispatches the `powersync-sync-reviewer` subagent on synced-table diffs (per the skill).
- ❌ No approval automation, no merge, no merge queue, no ruleset/CODEOWNERS changes, no App-counts-as-approval token. Existing branch protection is untouched.

## ⚠️ Verify before wiring

Several items are now **resolved** in the draft. The remaining open items are all **team-infra** (AWS/runner/App/CODEOWNERS) — they can't be pinned from code alone.

**Resolved (✅):**
1. ✅ **claude-code-action @v1 input names** — verified against the live @v1 `action.yml` (2026-06): `prompt`, `use_bedrock`, `claude_args`, `use_sticky_comment` all EXIST; `model:` / `allowed_tools:` / `review_event:` do NOT. Single comment owner decided: the post-step (so `use_sticky_comment: "false"`). Re-confirm only if the action major version changes.
2. ✅ **Action commit SHAs pinned** — `actions/checkout@9c091bb…` (v7.0.0), `anthropics/claude-code-action@806af32…` (v1), `aws-actions/configure-aws-credentials@e7f100cf…` (v6.2.0).
3. ✅ **Cursor Bugbot `app.id`** — set to `1210556` (slug `cursor`, "Cursor Bugbot") in `scripts/review-orchestrator.mjs`.
4. ✅ **Diff fetch** — replaced the `fetch-depth: 0` placeholder with a shallow head checkout + a targeted `git fetch --no-tags --depth 1 origin $PR_BASE_SHA $PR_HEAD_SHA`, so the diff runs against base..head only.

**Still open — team infra (a human MUST resolve each):**
5. **OIDC role ARN + Bedrock model ARNs** — create an IAM role (trust restricted to this repo+workflow) scoped to `bedrock:InvokeModel` on the specific model/inference-profile ARNs; set `role-to-assume`. Remove any static `AWS_ACCESS_KEY_ID/SECRET`.
6. **Pinned model id** — set the literal Bedrock Opus model id in `claude_args` (NOT `vars.*`). Example: `us.anthropic.claude-opus-4-...` — but confirm the region/inference-profile carries it.
7. **AWS region** — set `aws-region` to a region where the pinned model is available.
8. **Runner strategy** — choose GitHub-hosted or ephemeral/JIT self-hosted (clean VM per job, no Docker socket, no cloud-metadata, strict egress); set the runner label. Avoid a persistent self-hosted foothold.
9. **Reviewer App + `THUNDER_BOT_LOGIN`** — create the GitHub App and set `THUNDER_BOT_LOGIN` to its bot login (e.g. `thunder-deep-review[bot]`) so the orchestrator matches/resolves only its own threads.
10. **CODEOWNERS** — protect both `thunder-deep-review.yml` and `scripts/review-orchestrator.mjs` (see `CODEOWNERS-note.md`).

## To activate later (only with explicit approval)
1. Resolve the remaining open team-infra items above (5–10).
2. Check in `scripts/review-orchestrator.mjs` (CODEOWNERS-protected) and move `thunder-deep-review.yml` → `.github/workflows/`.
3. Open a test PR; confirm the bot posts an inline PR review (`event=COMMENT`) with comments on the relevant lines, posts only new findings + resolves its own threads on re-push, and never an approval.
Nothing here is wired, committed, or pushed.
