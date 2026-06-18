# CODEOWNERS protection note — DRAFT

When this draft is eventually wired, the workflow file and its orchestration
script **must be CODEOWNERS-protected**, because they hold (or reference)
privileged configuration that, if edited by anyone, changes the security
posture of every PR:

- `thunder-deep-review.yml` holds:
  - the **OIDC role ARN** that grants `bedrock:InvokeModel` (cloud spend + a
    trust relationship to this repo),
  - the **runner label/strategy** (a malicious edit could redirect jobs onto an
    attacker-controlled or persistent runner),
  - the **pinned model id** and pinned action SHAs (un-pinning re-opens the
    supply-chain hole the review closed),
  - the **fork/Dependabot/draft `if:` gate** (removing it would let untrusted
    fork code execute with cloud creds in context).
- `scripts/review-orchestrator.mjs` holds:
  - the **`EXPECTED_BOTS` app.id allowlist** (the dedup/skip-list trust anchor),
  - all the **GitHub I/O** that posts comments with `pull-requests: write`.

A change to either should require review from a trusted owner — not just any
contributor with write access.

## What to add (once these files live in their real locations)

In the repository `CODEOWNERS` file, add entries pointing the eventual real
paths at a trusted team/owner. Example (adjust paths + owner to reality):

```
# TODO: set the real owner team/handle.
/.github/workflows/thunder-deep-review.yml   @thunderbird/ci-owners   # <PLACEHOLDER owner>
/.github/scripts/review-orchestrator.mjs     @thunderbird/ci-owners   # <PLACEHOLDER owner>
```

Notes:
- CODEOWNERS only *enforces required review* when the branch's protection rule /
  ruleset has **"Require review from Code Owners"** enabled for the target
  branch. Confirm that is on, otherwise CODEOWNERS is advisory only.
- `.github/CODEOWNERS` is itself typically owned by the same trusted team so the
  protection can't be silently removed.
- This note is documentation only; it changes **no active `.github/` files**.
  `# TODO:` resolve the real paths and owner before wiring.
